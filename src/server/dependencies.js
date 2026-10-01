var EventEmitter = require('events').EventEmitter,
    WebSocket = require('faye-websocket'),
    http = require('http'),
    express = require('express'),
    md5,
    usage,
    influx;

try {
    md5 = require('MD5');
} catch (error) {
    md5 = false;
}

try {
    usage = require('usage');
} catch (error) {
    usage = false;
}

try {
    influx = require('influx');
} catch (error) {
    influx = false;
}

// tenten.run login, prize and win credit (shared mediaskills database)
var KurverMoney = require('../kurver-money.js');
