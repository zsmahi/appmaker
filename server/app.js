var speedcoach = require('speedcoach')
speedcoach('start')

if (process.argv.length < 3) {
  console.log('Specify a domain when starting')
  process.exit()
}

if (process.argv.length < 4) {
  console.log('Specify a port when starting')
  process.exit()
}

var http_server,
    io

var fs = require('fs'),
    express = require('express'),
    dns = require('dns'),
    https = require('https'),
    http = require('http'),
    request = require('request'),
    socketio = require('socket.io'),
    crypto = require('crypto'),
    exec = require('child_process').exec,
    _ = require('underscore'),
    parseCookie = require('cookie').parse,
    async = require('async'),
    Space = require('space'),
    File = require('./File'),
    Page = require('scraps'),
    Email = require('./email.js')

var app = express()
app.nudgepad = {}

// http://stackoverflow.com/questions/610406/javascript-equivalent-to-printf-string-format
//first, checks if it isn't implemented yet
if (!String.prototype.format) {
  String.prototype.format = function() {
    var args = arguments;
    return this.replace(/{(\d+)}/g, function(match, number) { 
      return typeof args[number] != 'undefined'
        ? args[number]
        : match
      ;
    });
  };
}

/*** PATHS ****/

var dataPath = '/nudgepad/'
var projectsPath = dataPath + 'sites/'
var clientPath = __dirname + '/../client/'
var activePath = dataPath + 'active/'
var portsPath = dataPath + 'ports/'

/********* CREATE MAIN NUDGE NAMESPACE SINGLETON OBJECT *********/

/**
 * Nudge is a singleton.
 */

app.nudgepad.domain = process.argv[2]
app.nudgepad.port = process.argv[3]
app.nudgepad.default_types = ['pages', 'posts', 'workers', 'timelines']

// Change the process title for easier debugging & monitoring
process.title = app.nudgepad.domain

if (!fs.existsSync(projectsPath + app.nudgepad.domain + '/')) {
  console.log('Site does not exist...')
  process.exit()
}

// Development always occurs on macs
app.nudgepad.isMac = process.env.HOME.match(/Users/)
app.nudgepad.development = !!app.nudgepad.isMac
// Set IP Address.
app.nudgepad.ip = process.env.IPADDRESS

// Add paths to app.nudgepad object
require('./paths.js')(app, projectsPath, clientPath)

// Run install script in case its not installed
require('./install.js')(app)

app.nudgepad.project = new Space()
var Room = new Space()

// Load the HTML file and add mtimes as query string so the
// worker always get the latest version of the nudgepad.js and nudgepad.css
// todo: remove this?
app.nudgepad.nudgepadCssVersion = fs.statSync(clientPath + 'production/nudgepad.min.css').mtime.getTime()
app.nudgepad.nudgepadJsVersion = fs.statSync(clientPath + 'production/nudgepad.min.js').mtime.getTime()
app.nudgepad.nudgepadHtmlVersion = fs.readFileSync(clientPath + 'production/nudgepad.min.html', 'utf8')
  .replace(/JSV/, app.nudgepad.nudgepadJsVersion)
  .replace(/CSSV/, app.nudgepad.nudgepadCssVersion)


// todo: remove this?
app.nudgepad.version = '2000'
app.nudgepad.started = new Date().getTime()


app.nudgepad.loadFolder = function (folder) {
  // Create a Space for every folder
  app.nudgepad.project.set(folder, new Space())
  // Grab all spaces in a folder
  var files = fs.readdirSync(app.nudgepad.paths.project + folder)
  for (var j in files) {
    // Dont read non space files
    if (!files[j].match(/\.space/))
      continue
    // Load every file into memory
    var filePath = app.nudgepad.paths.project + folder + '/' + files[j]
    app.nudgepad.project.set(folder + ' ' + files[j].replace(/\.space$/,''), new File(filePath).loadSync())
  }
}

/**
 * Load all Spaces into memory.
 */
app.nudgepad.loadSite = function () {
  
  // Load settings
  app.nudgepad.project.set('settings', new Space())
  var files = fs.readdirSync(app.nudgepad.paths.settings)
  for (var j in files) {
    // Space files
    if (files[j].match(/\.space/)) {
      var filename = files[j].replace(/\.space$/, '')
      app.nudgepad.project.set('settings ' + filename, new Space(fs.readFileSync(app.nudgepad.paths.settings + files[j], 'utf8')))
    }
    // Text files
    else if (files[j].match(/\.txt/)) {
      var filename = files[j].replace(/\.txt$/, '')
      app.nudgepad.project.set('settings ' + filename, fs.readFileSync(app.nudgepad.paths.settings + files[j], 'utf8'))
    }
  }
  
  // Iterate on each folder in default types
  for (var i in app.nudgepad.default_types) {
    app.nudgepad.loadFolder(app.nudgepad.default_types[i])
  }
  
}

/**
 * @param {string}
 * @return {string}
 */
app.hashString = function (string) {
  return crypto.createHash('sha256').update(string).digest("hex")
}

require('./checkId.js')(app)

//********************** INITIALIZE THE SERVER OBJECT ******************************


if (app.nudgepad.development)
  console.log('Development mode started...')
else
  console.log('Production mode started...')

/**
 * Emits an event to all open tabs.
 */
app.nudgepad.emit = function (event, string, socket) {
  
  // To emit it to all except the sending client
  if (socket)
    socket.broadcast.emit(event, string.toString())
  else
    io.sockets.emit(event, string.toString())
}

app.nudgepad.loadSite()
speedcoach('spaces loaded into memory')


app.nudgepad.patchFile = function (path, patch, email) {
  var filepath = app.nudgepad.paths.project + path.replace(/ /g, '/') + '.space'
  var file = app.nudgepad.project.get(path)
  var patchFile = patch.get(path)
  
   // Create File
   if (typeof file === 'undefined') {
     console.log('creating %s', path)
     file = new File(filepath, patchFile)
     file.create(function (error) {
       if (error) {
         console.log('Error: %s', error)
         return error
       }
     })
     app.nudgepad.project.set(path, file)
   }

   // Delete File
   else if (typeof file !== 'undefined' && patchFile.toString() === '') {
     console.log('deleting %s', path)
     file.trash(function (error) {
       if (error) {
         console.log('Error: %s', error)
         return error
       }
     })
     app.nudgepad.project.delete(path)
   }

   // Update File
   else {
     console.log('updating %s', path)
     file.patch(patchFile).save(function (error) {
       if (error) {
         console.log('Error: %s', error)
         return error
       }
     })

   }
  
}

app.nudgepad.patchSite = function (patch, email) {
  
  console.log('receiving patch')
  
  // now, modify file system.
   for (var i in patch.keys) {
     var folder = patch.keys[i]
     // For every file in folder
     for (var j in patch.values[folder].keys) {
       var name =  patch.values[folder].keys[j]
       app.nudgepad.patchFile(folder + ' ' + name, patch, email)
     }
   }
}


app.use(express.bodyParser())
app.use(express.cookieParser())
app.use(express.compress())
// server.use(express.staticCache())

// http://www.dmuth.org/node/1401/logging-non-proxy-ip-addresses-heroku-and-express-nodejs
//
// Create an IP token for the logging system that lists the original IP, 
// if there was a proxy involved.
//
express.logger.token("ip", function(request) {
 
   var retval = "";
 
   if (request["headers"] && request["headers"]["x-forwarded-for"]) {
      //
      // Proxied request
      //
      retval = request["headers"]["x-forwarded-for"];
 
   } else if (request["socket"] && request["socket"]["remoteAddress"]) {
      //
      // Direct request
      //
      retval = request["socket"]["remoteAddress"];
 
   } else if (request["socket"] && request["socket"]["socket"]
      && request["socket"]["socket"]["remoteAddress"]) {
      //
      // God only knows what happened here...
      //
      retval = request["socket"]["socket"]["remoteAddress"];
 
   }
 
   return(retval);
 
});

var logFile = fs.createWriteStream(app.nudgepad.paths.requests_log, {flags: 'a'})
app.use(express.logger({
  stream : logFile,
  format : ':ip :url :method :status :response-time :res[content-length] ":date" :remote-addr ":referrer" ":user-agent"'
}))



/*********** STATIC FILES **************/
app.use('/nudgepad/', express.static(clientPath.replace(/\/$/,''), { maxAge: 31557600000 }))


/*********** public ***********/
app.use('/', express.static(app.nudgepad.paths.public, { maxAge: 31557600000 }))

/********** blog *************/
require('./blog.js')(app)

/********** surveys *************/
require('./surveys.js')(app)

/********** email *************/
app.post('/nudgepad.email', app.checkId, function (req, res, next) {

  var to = req.body.to
  var subject = req.body.subject
  var message = req.body.message
  var from = 'nudgepad@' + app.nudgepad.domain
  
  Email.send(to, from, subject, message, null, function (error) {
    if (error)
      res.send(error, 500)
    else
      res.send('Sent')
  })  

})


/********** invite *************/
require('./invite.js')(app)

/********** images *************/
require('./images.js')(app)

/*********** nudgepad ***********/
app.get(/^\/nudgepad$/, app.checkId, function(req, res, next) {

  // If production, send html that pulls minified NudgePad
  if (!app.nudgepad.development) {
    res.send(app.nudgepad.nudgepadHtmlVersion)
    return
  }
  
  // If development, send html that pulls verbose NudgePad
  fs.readFile(clientPath + 'production/nudgepad.dev.html', 'utf8', function (err, data) {
    res.send(data)
    return 
  })

})

// If development, watch client folder and trigger rebuilds.
// NudgePad app developer should never have to manually run build.js
// Watch core and tools folder recursively.
app.rebuild = function () {
  exec('node ' + clientPath + 'build.js')
  console.log('Rebuilding...')
}

app.watchDir = function (dir) {
  console.log('watching %s', dir)
  fs.watch(dir, app.rebuild)
  var files = fs.readdirSync(dir)
  _.each(files, function (file) {
    var path = dir + '/' + file
    var stat = fs.statSync(path)
    if (stat.isDirectory())
      app.watchDir(path)
    else
      fs.watch(path, app.rebuild)
  })
}

if (app.nudgepad.development) {
  app.watchDir(clientPath + 'tools')
  app.watchDir(clientPath + 'core')
}

/*********** sendPage method ************/
app.pageOptions = {
  beautify : true
}

app.sendPage = function(req, res, name) {
  
  var scraps = app.nudgepad.project.get('pages ' + name)
  var page = new Page(scraps)
  var context = {}
  context.project = app.nudgepad.project
  context.request = req
  return res.send(page.toHtml(context, app.pageOptions))
}

/*********** patch methods ************/
require('./patch.js')(app)

/*********** nudgepad.project ************/
require('./project.js')(app)


/*********** nudgepad.backup ***********/
require('./backup.js')(app)

/*********** nudgepad.explorer ***********/
require('./explorer.js')(app)

/*********** nudgepad.restart ***********/
require('./restart.js')(app)

/*********** nudgepad.domain ***********/
// We use this to communicate with proxy.js so it knows what
// domain this process serves
app.get('/nudgepad.domain', function(req, res, next) {
  res.set('Content-Type', 'text/plain')
  return res.send(app.nudgepad.domain)
})

/*********** nudgepad.status ***********/
require('./status.js')(app, speedcoach)

/*********** nudgepad.whoami ***********/
require('./whoami.js')(app)

/*********** serverSession ***********/
// We use this so we can tell if the server has been
// restarted since the clients session started
app.get('/nudgepad.started', app.checkId, function (req, res, next) {
  res.set('Content-Type', 'text/plain')
  return res.send(app.nudgepad.started + '')
})

/*********** nudgepad.console ***********/
require('./console.js')(app)

/*********** watches disk ***********/
fs.watch(app.nudgepad.paths.public, function (event, filename) {
  
  // Trigger public changed event
  // mac on old node wont emit filename
  if (!filename)
    filename = ''
  app.nudgepad.emit('public', filename)
  
})

/*
todo: experiment with watching this folder for all updates.
fs.watch(app.nudgepad.paths.project + 'pages/', function (event, filename) {
  
  // Trigger public changed event
  app.nudgepad.loadFolder('pages')
})
*/

/*********** export project ***********/
require('./export.js')(app)

/*********** nudgepad.login ***********/
require('./login.js')(app)

/*********** nudgepad.persona ***********/
require('./persona.js')(app)

/*********** nudgepad.forgotPassword ***********/
require('./forgotPassword.js')(app)

/*********** nudgepad.worker.### ************/
require('./updateEmail.js')(app)

/*********** nudgepad.logout ***********/
require('./logout.js')(app)

/*********** nudgepad.logs ***********/
require('./logs.js')(app)

/*********** nudgepad.clear ***********/
require('./clear.js')(app)

/*********** / ***********/
require('./home.js')(app)

/*********** stats ***********/
require('./stats.js')(app)

/*********** fs ***********/
require('./ExpressFs.js')(app)

/*********** import ***********/
require('./import.js')(app)


/*********** {page_name} ***********/
require('./pages.js')(app)


/*********** Eval any custom code ***********/
try {
  
  var files = fs.readdirSync(app.nudgepad.paths.packages)
  for (var j in files) {
    require(app.nudgepad.paths.packages + files[j])(app)
  }
} catch (e) {
  if (e instanceof SyntaxError) {
    console.log('Syntax error in ' + files[j] + ': ' + e.message)
    console.log('Includes skipped')
  } else {
    console.log('Error in ' + files[j] + ': ' + e.message)
  }
}


/*********** ! ***********/
app.use('/', function (req, res, next) {
  

  var page = app.nudgepad.project.get('pages').get('notFound')
  if (!page)
    return res.send('Not found', 404)
  
  page = new Page(page.values)
  return res.send(page.toHtml(), 404)
  
  
})




/********* START SERVER **********/ 

// Start Listening
console.log('Starting %s on port %s', app.nudgepad.domain, app.nudgepad.port)
http_server = http.createServer(app).listen(app.nudgepad.port)


fs.writeFileSync(activePath + app.nudgepad.domain, app.nudgepad.port, 'utf8')
fs.chmodSync(activePath + app.nudgepad.domain, '600')
fs.writeFileSync(portsPath + app.nudgepad.port, app.nudgepad.domain, 'utf8')
fs.chmodSync(portsPath + app.nudgepad.port, '600')

// Write session stats to disk before process closes
process.on('SIGTERM', function () {
  fs.unlinkSync(activePath + app.nudgepad.domain)
  fs.unlinkSync(portsPath + app.nudgepad.port)
  process.exit(0)
})


speedcoach('server started')

/********* SOCKET IO STUFF **********/ 
io = socketio.listen(http_server)

//io.set('log level', 3)

/********* SOCKET EVENTS **********/ 

io.set('authorization', function (data, accept) {

  if (!data.headers.cookie)
    return accept('No cookie transmitted.', false)
  
  var cookie = parseCookie(data.headers.cookie)

  var worker = app.nudgepad.project.get('workers ' + cookie.email)
  if (!worker)
    return accept('Invalid worker "' + cookie.email + '" transmitted. Headers:' + data.headers.cookie, false)

  // Wrong key
  if (worker.get('key') !== cookie.key)
    return accept('Invalid key transmitted.', false)
  
  data.cookie = cookie
  data.screenId = new Date().getTime()
  Room.set(data.screenId, new Space())
    
  // todo: broadcast worker
  return accept(null, true)  
  
})

io.sockets.on('connection', function (socket) {
  
  socket.on('room.change', function (space) {
    if (socket.handshake.screenId) {
      Room.set(socket.handshake.screenId, space)
      app.nudgepad.emit('room.change', Room.toString(), socket)
    }
  })
  
  socket.on('disconnect', function () {
    if (socket.handshake.screenId) {
      Room.delete(socket.handshake.screenId)
      app.nudgepad.emit('room.change', Room.toString(), socket)
    }
  })
  
  socket.on('patch', function (space, fn) {
    var patch = new Space(space)
    app.nudgepad.patchSite(patch, socket.handshake.cookie.email)
    
    fn('patch received')
    
    // Broadcast to everyone else
    app.nudgepad.emit('patch', space, socket)
  })

})


speedcoach('socket loaded')

console.log('Server started...')
speedcoach('end of nudgepad.js')
