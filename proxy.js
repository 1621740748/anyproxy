try{
    GLOBAL.util = require('./lib/util');
}catch(e){}

var http = require('http'),
    https           = require('https'),
    fs              = require('fs'),
    async           = require("async"),
    url             = require('url'),
    program         = require('commander'),
    color           = require('colorful'),
    certMgr         = require("./lib/certMgr"),
    getPort         = require("./lib/getPort"),
    requestHandler  = require("./lib/requestHandler"),
    Recorder        = require("./lib/recorder"),
    logUtil         = require("./lib/log"),
    inherits        = require("util").inherits,
    util            = require("./lib/util"),
    path            = require("path"),
    juicer          = require('juicer'),
    events          = require("events"),
    express         = require("express"),
    ip              = require("ip"),
    fork            = require("child_process").fork,
    ThrottleGroup   = require("stream-throttle").ThrottleGroup,
    iconv           = require('iconv-lite'),
    Buffer          = require('buffer').Buffer,
    WebSocketServer = require('ws').Server;


var T_TYPE_HTTP            = 0,
    T_TYPE_HTTPS           = 1,
    DEFAULT_PORT           = 8001,
    DEFAULT_WEB_PORT       = 8002, // port for web interface
    DEFAULT_WEBSOCKET_PORT = 8003, // internal web socket for web interface, not for end users
    DEFAULT_CONFIG_PORT    = 8088,
    DEFAULT_HOST           = "localhost",
    DEFAULT_TYPE           = T_TYPE_HTTP;

var default_rule = require('./lib/rule_default');

//may be unreliable in windows
try{
    var anyproxyHome = path.join(util.getUserHome(),"/.anyproxy/");
    if(!fs.existsSync(anyproxyHome)){
        fs.mkdirSync(anyproxyHome);
    }
    if(fs.existsSync(path.join(anyproxyHome,"rule_default.js"))){
        default_rule = require(path.join(anyproxyHome,"rule_default"));
    }
    if(fs.existsSync(path.join(process.cwd(),'rule.js'))){
        default_rule = require(path.join(process.cwd(),'rule'));
    }
}catch(e){
    if(e){
        logUtil.printLog("error" + e, logUtil.T_ERR);
        throw e;
    }
}

//option
//option.type     : 'http'(default) or 'https'
//option.port     : 8001(default)
//option.hostname : localhost(default)
//option.rule          : ruleModule
//option.webPort       : 8002(default)
//option.socketPort    : 8003(default)
//option.webConfigPort : 8088(default)
//option.dbFile        : null(default)
//option.throttle      : null(default)
//option.disableWebInterface
//option.silent        : false(default)
//option.interceptHttps ,internal param for https
function proxyServer(option){
    option = option || {};

    var self       = this,
        proxyType           = /https/i.test(option.type || DEFAULT_TYPE) ? T_TYPE_HTTPS : T_TYPE_HTTP ,
        proxyPort           = option.port     || DEFAULT_PORT,
        proxyHost           = option.hostname || DEFAULT_HOST,
        proxyRules          = option.rule     || default_rule,
        proxyWebPort        = option.webPort       || DEFAULT_WEB_PORT,       //port for web interface
        socketPort          = option.socketPort    || DEFAULT_WEBSOCKET_PORT, //port for websocket
        proxyConfigPort     = option.webConfigPort || DEFAULT_CONFIG_PORT,    //port to ui config server
        disableWebInterface = !!option.disableWebInterface,
        ifSilent            = !!option.silent,
        wss,
        child_webServer;

    if(ifSilent){
        logUtil.setPrintStatus(false);
    }

    if(option.dbFile){
        GLOBAL.recorder = new Recorder({filename: option.dbFile});
    }else{
        GLOBAL.recorder = new Recorder();
    }

    if(!!option.interceptHttps){
        default_rule.setInterceptFlag(true);
    }

    if(option.throttle){
        logUtil.printLog("throttle :" + option.throttle + "kb/s");
        GLOBAL._throttle = new ThrottleGroup({rate: 1024 * parseInt(option.throttle) }); // rate - byte/sec
    }

    requestHandler.setRules(proxyRules); //TODO : optimize calling for set rule
    self.httpProxyServer = null;

    async.series(
        [
            //creat proxy server
            function(callback){
                if(proxyType == T_TYPE_HTTPS){
                    certMgr.getCertificate(proxyHost,function(err,keyContent,crtContent){
                        if(err){
                            callback(err);
                        }else{
                            self.httpProxyServer = https.createServer({
                                key : keyContent,
                                cert: crtContent
                            },requestHandler.userRequestHandler);
                            callback(null);
                        }
                    });

                }else{
                    self.httpProxyServer = http.createServer(requestHandler.userRequestHandler);
                    callback(null);
                }
            },

            function(callback){
                //listen CONNECT request for https over http
                self.httpProxyServer.on('connect',requestHandler.connectReqHandler);

                //start proxy server
                self.httpProxyServer.listen(proxyPort);
                callback(null);
            },

            //start web interface
            function(callback){
                if(disableWebInterface){
                    logUtil.printLog('web interface is disabled');
                }else{
                    //[beta] customMenu
                    var customMenuConfig = proxyRules.customMenu,
                        menuList    = [],
                        menuListStr;

                    if(customMenuConfig && customMenuConfig.length){
                        for(var i = 0 ; i < customMenuConfig.length ; i++){
                            menuList.push(customMenuConfig[i].name);
                        }
                    }
                    menuListStr = menuList.join("@@@");

                    //web interface
                    var args = [proxyWebPort, socketPort, proxyConfigPort, requestHandler.getRuleSummary(), ip.address(),menuListStr];
                    child_webServer = fork(path.join(__dirname,"./webServer.js"),args);

                    //deal websocket data
                    var wsDataDealer = function(){};
                    inherits(wsDataDealer,events.EventEmitter);
                    var dealer = new wsDataDealer();

                    GLOBAL.recorder.on("update",function(data){
                        wss && wss.broadcast({
                            type   : "update",
                            content: data
                        });
                    });

                    dealer.on("message",function(ws,jsonData){
                        if(jsonData.type == "reqBody" && jsonData.id){
                            GLOBAL.recorder.getBodyUTF8(jsonData.id, function(err, data){
                                var result = {};

                                if(err){
                                    result = {
                                        type : "body",
                                        id   : null,
                                        body : null,
                                        error: err.toString()
                                    };    
                                }else{
                                    result = {
                                        type : "body",
                                        id   : data.id,
                                        body : data
                                    };
                                }
                                ws.send(JSON.stringify(result));
                            });
                        }
                    });

                    dealer.on("message",function(ws,jsonData){
                        // another dealer here...
                    });

                    //web socket interface
                    wss = new WebSocketServer({port: socketPort});
                    wss.on("connection",function(ws){
                        ws.on("message",function(msg){
                            try{
                                var msgObj = JSON.parse(msg);
                                dealer && dealer.emit("message",ws,msgObj);
                            }catch(e){
                                var result = {
                                    type : "error",
                                    error: "failed to parse your request : " + e.toString()
                                };
                                ws.send(JSON.stringify(result));
                            }
                        });
                    });
                    wss.broadcast = function(data) {
                        if(typeof data == "object"){
                            data = JSON.stringify(data);
                        }

                        for(var i in this.clients){
                            try{
                                this.clients[i].send(data);
                            }catch(e){
                                logUtil.printLog("websocket failed to send data, " + e, logUtil.T_ERR);
                            }
                        }
                    };

                    //watch dog
                    setInterval(function(argument) {
                        child_webServer.send({
                            type:"watch"
                        });
                    },5000);
                }
                callback(null);
            },

            //server status manager
            function(callback){

                //kill web server when father process exits
                process.on("exit",function(code){
                    child_webServer.kill();
                    logUtil.printLog('AnyProxy is about to exit with code: ' + code, logUtil.T_ERR);
                    process.exit();
                });

                process.on("uncaughtException",function(err){
                    child_webServer.kill();
                    logUtil.printLog('Caught exception: ' + err, logUtil.T_ERR);
                    process.exit();
                });

                var tipText,webUrl;
                webUrl  = "http://" + ip.address() + ":" + proxyWebPort +"/";
                tipText = "GUI interface started at : " + webUrl;
                logUtil.printLog(color.green(tipText));

                // tipText = "[alpha]qr code to for iOS client: " + webUrl + "qr";
                // logUtil.printLog(color.green(tipText));
                callback(null);
            }
        ],

        //final callback
        function(err,result){
            if(!err){
                var tipText = (proxyType == T_TYPE_HTTP ? "Http" : "Https") + " proxy started at " + color.bold(ip.address() + ":" + proxyPort);
                logUtil.printLog(color.green(tipText));
            }else{
                var tipText = "err when start proxy server :(";
                logUtil.printLog(color.red(tipText), logUtil.T_ERR);
                logUtil.printLog(err, logUtil.T_ERR);
            }
        }
    );

    self.close = function(){
        self.httpProxyServer && self.httpProxyServer.close();
        logUtil.printLog(color.green("server closed :" + proxyHost + ":" + proxyPort));
    }
}

// BETA : UIConfigServer
function UIConfigServer(port){
    var self = this;

    var app          = express(),
        customerRule = {
            summary: function(){
                logUtil.printLog("replace some response with local response");
                return "replace some response with local response";
            }
        },
        userKey;

    port = port || DEFAULT_CONFIG_PORT;

    customerRule.shouldUseLocalResponse = function(req,reqBody){
        var url = req.url;
        if(userKey){
            var ifMatch = false;
            userKey.map(function(item){
                if(ifMatch) return;

                var matchCount = 0;
                if( !item.urlKey && !item.reqBodyKey){
                    ifMatch = false;
                    return;
                }else{
                    if(!item.urlKey || (item.urlKey && url.indexOf(item.urlKey) >= 0 ) ){
                        ++matchCount;
                    }

                    if(!item.reqBodyKey || (item.reqBodyKey && reqBody.toString().indexOf(item.reqBodyKey) >= 0) ){
                        ++matchCount;
                    }

                    ifMatch = (matchCount==2);
                    if(ifMatch){
                        req.willResponse = item.localResponse;
                    }
                }
            });

            return ifMatch;
        }else{
            return false;
        }
    };

    customerRule.dealLocalResponse = function(req,reqBody,callback){
        callback(200,{"content-type":"text/html"},req.willResponse);
        return req.willResponse;
    };

    app.post("/update",function(req,res){
        var data = "";
        req.on("data",function(chunk){
            data += chunk;
        });

        req.on("end",function(){
            userKey = JSON.parse(data);

            res.statusCode = 200;
            res.setHeader("Content-Type", "application/json;charset=UTF-8");
            res.end(JSON.stringify({success : true}));

            requestHandler.setRules(customerRule);
            self.emit("rule_changed");
        });
    });

    app.use(express.static(__dirname + "/web_uiconfig"));
    app.listen(port);

    self.app = app;
}

// var configServer = new UIConfigServer(proxyConfigPort);
// configServer.on("rule_changed",function() {});
// inherits(UIConfigServer, events.EventEmitter);


module.exports.proxyServer        = proxyServer;
module.exports.generateRootCA     = certMgr.generateRootCA;
module.exports.isRootCAFileExists = certMgr.isRootCAFileExists;
