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
  
  var updateToken = process.env.API_TOKEN || '5e73bff191bf0a9c509a31576ee966f9' || require('crypto').randomBytes(16).toString("hex");

  app.get(ctxRoot + 'serviceUpdate',function(req,res){
	  if (updateToken != req.get('Authorization')) {
		  res.json({error:'Unauthorized request'});
	  } else if (req.query.service && req.query.image) {
		  docker.createImage(
				  {"key": req.get('X-Registry-Authorization')},
				  {fromImage: req.query.image}, 
				  function (err, stream) {
			  		if (!err) {
			  			var srv = docker.getService(req.query.service);
			  			srv.inspect(function (err, data) {
			  				if (!err) {
			  					var prevImg = data.Spec.TaskTemplate.ContainerSpec.Image;
			  					srv.update({"key": req.get('X-Registry-Authorization')},
			  							   {
			  						  		"Name": "nodingdesa_noding",
			  						  		"version": parseInt(data.Version.Index),
			  						  		"TaskTemplate": {
			  						  			"ContainerSpec": {
			  						  				"Image": req.query.image
			  						  			},
			  						  			"Resources": {
			  						  				"Limits": {},
			  						  				"Reservations": {}
			  						  			},
					  						    "RestartPolicy": {
					  						      "Condition": "any",
					  						      "MaxAttempts": 0
					  						    },
					  						    "Placement": {},
					  						    "ForceUpdate": 1
			  						  		}
			  							   },function (err, data) {
			  								   if (!err) {
			  									   res.json({
			  										   previousImage: prevImg,
			  										   newImage: req.query.image,
			  										   response: data
			  									   });
			  								   } else {
			  									   console.log(err);
			  								   }
			  							   });
			  				} else {
			  					console.log(err);
			  				}
			  			});
			  		} else {
			  			console.log(err);
			  			res.json(err);
			  		}
			});
	  } else {
		  res.json({error:'Missing parameters'});
	  }
  });
  