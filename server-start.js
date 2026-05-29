'use strict';

/**
 * Single entry point that replicates what gulp's 'server' task produces:
 * it concatenates all files listed in recipes/server.json into one string and
 * compiles them as a single module.  This is necessary because the source files
 * are written to share a global scope (no module.exports) — they define bare
 * variables that later files in the bundle reference directly.
 *
 * Module._compile is used so that require(), __dirname and __filename are all
 * available inside the combined code.  The filename is set to launcher.js so
 * its relative require('../package.json') and require('../config.json') resolve
 * to src/package.json and src/config.json.
 */

var fs     = require('fs');
var path   = require('path');
var Module = require('module');

// Exact order from recipes/server.json:
//   src/server/dependencies.js
//   src/shared/**/*.js
//   src/server/*/**/*.js   (every subfolder except the top level, then launcher last)
//   src/server/launcher.js
var files = [
    'src/server/dependencies.js',

    // src/shared/**/*.js
    'src/shared/Collection.js',
    'src/shared/core/BaseSocketClient.js',
    'src/shared/manager/BaseBonusManager.js',
    'src/shared/model/BaseAvatar.js',
    'src/shared/model/BaseBonus.js',
    'src/shared/model/BaseBonusStack.js',
    'src/shared/model/BaseGame.js',
    'src/shared/model/BasePlayer.js',
    'src/shared/model/BaseRoom.js',
    'src/shared/model/BaseRoomConfig.js',
    'src/shared/model/BaseTrail.js',
    'src/shared/model/Preset.js',
    'src/shared/service/BaseChat.js',
    'src/shared/service/BaseFPSLogger.js',
    'src/shared/service/BaseTickrateLogger.js',
    'src/shared/service/Compressor.js',

    // src/server/*/**/*.js
    'src/server/controller/GameController.js',
    'src/server/controller/RoomController.js',
    'src/server/controller/RoomsController.js',
    'src/server/core/AvatarBody.js',
    'src/server/core/Body.js',
    'src/server/core/Inspector.js',
    'src/server/core/Island.js',
    'src/server/core/PingLogger.js',
    'src/server/core/Server.js',
    'src/server/core/SocketClient.js',
    'src/server/core/SocketGroup.js',
    'src/server/core/World.js',
    'src/server/manager/BonusManager.js',
    'src/server/manager/KickManager.js',
    'src/server/manager/PrintManager.js',
    'src/server/model/Avatar.js',
    'src/server/model/Bonus/Bonus.js',
    'src/server/model/Bonus/BonusAll.js',
    'src/server/model/Bonus/BonusAllColor.js',
    'src/server/model/Bonus/BonusEnemy.js',
    'src/server/model/Bonus/BonusEnemyBig.js',
    'src/server/model/Bonus/BonusEnemyFast.js',
    'src/server/model/Bonus/BonusEnemyInverse.js',
    'src/server/model/Bonus/BonusEnemySlow.js',
    'src/server/model/Bonus/BonusEnemyStraightAngle.js',
    'src/server/model/Bonus/BonusGame.js',
    'src/server/model/Bonus/BonusGameBorderless.js',
    'src/server/model/Bonus/BonusGameClear.js',
    'src/server/model/Bonus/BonusSelf.js',
    'src/server/model/Bonus/BonusSelfFast.js',
    'src/server/model/Bonus/BonusSelfGodzilla.js',
    'src/server/model/Bonus/BonusSelfMaster.js',
    'src/server/model/Bonus/BonusSelfSlow.js',
    'src/server/model/Bonus/BonusSelfSmall.js',
    'src/server/model/BonusStack.js',
    'src/server/model/Game.js',
    'src/server/model/GameBonusStack.js',
    'src/server/model/KickVote.js',
    'src/server/model/Message.js',
    'src/server/model/Player.js',
    'src/server/model/Room.js',
    'src/server/model/RoomConfig.js',
    'src/server/model/Trail.js',
    'src/server/repository/RoomRepository.js',
    'src/server/service/Chat.js',
    'src/server/service/FPSLogger.js',
    'src/server/service/FloodFilter.js',
    'src/server/service/RoomNameGenerator.js',
    'src/server/trackers/Tracker.js',
    'src/server/trackers/TrackerClient.js',
    'src/server/trackers/TrackerGame.js',
    'src/server/trackers/TrackerRoom.js',

    'src/server/launcher.js'
];

var root = __dirname;

var combined = files.map(function (f) {
    return fs.readFileSync(path.join(root, f), 'utf8');
}).join('\n;\n');

// Compile as if the file were src/server/launcher.js so its relative
// require('../package.json') → src/package.json
// require('../config.json')  → src/config.json
var launcherPath = path.join(root, 'src', 'server', 'launcher.js');

var m = new Module(launcherPath, module);
m.filename = launcherPath;
m.paths    = Module._nodeModulePaths(path.dirname(launcherPath));
m._compile(combined, launcherPath);
