var url = require('url')
var fs = require('fs');
var express = require('express');
var _  = require('lodash');
var superagent = require('superagent');
var net = require('net');
var http = require('http');
var https = require('https');
var WS = require('ws');
var Docker = require('dockerode');

var WebSocketServer = WS.Server;
var indexData;
var app = express();
var ms = process.env.MS || 5000;
process.env.MS=ms

var ctxRoot = process.env.CTX_ROOT || '/';

if ( !ctxRoot.startsWith('/') ) {
	ctxRoot = '/' + ctxRoot;
}

if ( !ctxRoot.endsWith('/') ) {
	ctxRoot = ctxRoot + '/';
}

app.use(ctxRoot, express.static('dist'));

var server = app.listen(8080, function () {
    indexData = _.template(fs.readFileSync('index.tpl'))(process.env);

});

app.get(ctxRoot, function(req, res) {
  res.send(indexData);
});

if (process.env.DOCKER_HOST) {
  console.log("Docker Host: " + process.env.DOCKER_HOST)
}
  if(process.env.DOCKER_HOST) {
     try {
	   dh = process.env.DOCKER_HOST.split(":");
	   var docker_host = dh[0];
	   var docker_port = dh[1];
     }
	 catch (err) {
	   console.log(err.stack)
     }
	}
  var cert_path;
  if (process.env.DOCKER_TLS_VERIFY) {
    if (process.env.DOCKER_CERT_PATH) {
      cert_path = process.env.DOCKER_CERT_PATH;
    } else {
      cert_path = (process.env.HOME || process.env.USERPROFILE) + "/.docker"
    }
  }

  var wss = new WebSocketServer({server: server});

  app.get(ctxRoot + 'apis/*', function(req, response) {
      var path = req.params[0];
      var jsonData={};
      var options = {
		  path: ('/' + path),
		  method: 'GET'
	  }

    var request = http.request;

    if (cert_path) {
        request = https.request;
        options.ca = fs.readFileSync(cert_path + '/ca.pem');
        options.cert = fs.readFileSync(cert_path + '/cert.pem');
        options.key = fs.readFileSync(cert_path + '/key.pem');
    }

    if (docker_host) {
        options.host = docker_host;
        options.port = docker_port;
    } else if (process.platform === 'win32') {
        options.socketPath = '\\\\.\\pipe\\docker_engine';
    } else {
        options.socketPath = '/var/run/docker.sock';
    }

    var req = request(options, (res) => {
      var data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        jsonData['objects'] = JSON.parse(data.toString());
        response.json(jsonData);
      });
    });
    req.on('error', (e) => {
      console.log(`problem with request: ${e.message}`);
      console.log(e.stack);
    });
      req.end();

  });

  var docker;
  if (docker_host) {
      docker = new Docker({host: docker_host, port: docker_port});
  } else if (process.platform === 'win32') {
      docker = new Docker({socketPath: '\\\\.\\pipe\\docker_engine'});
  } else {
	  docker = new Docker({socketPath: '/var/run/docker.sock'});
  }
  var workers = [];
  var getUpdateObject = function(ver,image,spec) {
	  var uobj = spec;
	  uobj.version = ver;
	  uobj.Labels['com.docker.stack.image'] = image;
	  uobj.TaskTemplate.ContainerSpec.Image = image;
	  uobj.TaskTemplate.ForceUpdate = 1;
	  return uobj;
  }
  var fireError = function(id,err,res) {
	  console.log("Error["+id+"]");
	  console.log(err);
	  res.json(err);
  }
  var updateToken = process.env.API_TOKEN || require('crypto').randomBytes(16).toString("hex");
  if (!process.env.API_TOKEN) { console.log('#RandomApiKey: '+updateToken); }
  app.get(ctxRoot + 'serviceUpdate',function(req,res){
	  if (updateToken != req.get('Authorization')) {
		  res.json({error:'Unauthorized request'});
	  } else if (req.query.service && req.query.image) {
		  var auth = {'authconfig':{'key': req.get('X-Registry-Authorization')}};
		  docker.pull(req.query.image,auth,
				  function (err, stream) {
			  		if (!err) {
			  			docker.modem.followProgress(stream, 
			  				function(err, output) {
			  					if (!err) {
			  						var srv = docker.getService(req.query.service);
			  						srv.inspect(function (err, data) {
			  							if (!err) {
			  								var prevImg = data.Spec.TaskTemplate.ContainerSpec.Image;
			  								srv.update(auth,
					  								getUpdateObject(parseInt(data.Version.Index),req.query.image,data.Spec),
					  								function (err, data) {
					  								   if (!err) {
					  									   res.json({
					  										   previousImage: prevImg,
					  										   newImage: req.query.image,
					  										   response: data
					  									   });
					  								   } else {
					  									   fireError(1,err,res);
					  								   }
			  										});
			  							} else {
			  								fireError(2,err,res);
			  							}
			  						});
					  			} else {
					  				fireError(3,err,res);
					  			}
					  		},
				  			function(event) {
				  				console.log(event);
			  				});
			  		} else {
			  			fireError(4,err,res);
			  		}
			});
	  } else {
		  res.json({error:'Missing parameters'});
	  }
  });
  
  app.get(ctxRoot + 'imageUpdate',function(req,res){
	  if (updateToken != req.get('Authorization')) {
		  res.json({error:'Unauthorized request'});
	  } else if (req.query.image) {
		  var auth = {'authconfig':{'key': req.get('X-Registry-Authorization')}};
		  var response = [];
		  docker.pull(req.query.image,auth)
		  	.then(function(img){
		  		response.push({image:req.query.image,node:'manager'});
		  		workers.forEach(function(wrk, idx, array){
		  			wrk.pull(req.query.image,auth)
		  				.then(function(img){
		  					response.push({image:req.query.image,node:'worker'});
				  			if (idx === array.length - 1){
				  				res.json(response);
				  			}		  					
		  				})
		  				.catch(function(err){
		  					fireError(0,err,res);
		  				});
		  		});
		  		if (workers.length==0) {
		  			res.json(response);
		  		}
		  	})
		  	.catch(function(err){
		  		fireError(1,err,res);
		  	});
	  } else {
		  res.json({error:'Missing parameters'});
	  }
  });

  app.get(ctxRoot + 'addWorker',function(req,res){
	  if (updateToken != req.get('Authorization')) {
		  res.json({error:'Unauthorized request'});
	  } else if (req.query.host) {
		  var wdocker = new Docker({host: req.query.host, port: 2376});
		  workers.push(wdocker);
		  res.json({worker:req.query.host})
	  } else {
		  res.json({error:'Missing parameters'});
	  }
  });
