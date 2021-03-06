import express from 'express';
import mongoose from 'mongoose';
import path from 'path';
import open from 'open';
import request from 'request-promise';
import xml2js from 'xml2js';
import fs from 'fs';
import bodyParser from 'body-parser';
import cookieParser from 'cookie-parser';
import { userSchema, loginSchema } from './mongoSchemas.js';
import expressValidator from 'express-validator';
import registrationSchema from './validationSchemas/validationSchemas.js';
import { check, validationResult } from 'express-validator/check';
import sessionMangementConfig from './configurations/sessionManagementConfig.js';
import { getMongoConnection } from './configurations/serverSettings.js';
import https from 'https';
import session from 'express-session';
//import User from './models/userModel';
//import userRouter from './routes/userRouter';

/* eslint-disable no-console */

const port = (process.env.PORT || 3000);
const app = express();


const mongoLink = getMongoConnection();

mongoose.Promise = global.Promise;
mongoose.connect(mongoLink, { useMongoClient: true });
let db = mongoose.connection;
db.on('error', console.error.bind(console, 'MongoDB connection error:'));


let userModel = mongoose.model('users', userSchema);
let parser = new xml2js.Parser();

if (process.env.NODE_ENV !== 'production') {
  const webpack = require('webpack');
  const config = require('../webpack.config.js');
  const compiler = webpack(config);

  app.use(require('webpack-dev-middleware')(compiler, {
    noInfo: true,
    publicPath: config.output.publicPath
  }));

  app.use(require('webpack-hot-middleware')(compiler));
} else {
  app.use(express.static(path.resolve(__dirname, '../public')));
}


app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

app.use(cookieParser());
app.use(expressValidator());
sessionMangementConfig(app, db);

//app.use('/api/users', userRouter(User));


function getUsersFeeds(username, filter, callback) {
  userModel.findOne({ username: username }, function (err, user) {
    if (err || !user) {
      callback(err, null);
    } else {
      let urls = [];
      user.categories.map(item => {
        if (!filter || item.categoryTitle === filter) {
          urls = [...urls, ...getUrls(item)];
        }

      });
      callback(false, urls);
    }
  });
}

function getUrls(item) {
  let urls = [];
  if (item.categoryUrls && item.categoryUrls[0] !== "") {
    for (let url of item.categoryUrls) {
      if (url) {
        urls.push(url);
      }
    }
  }
  return urls;
}

app.post('/api/rss', function (req, res) {
  let JSONS = [];
  let { username, filter } = req.body;
  if (!(username && req.session && req.session.userInfo && req.session.userInfo.username === username)) {
    res.send({ error: "not logged" });
    return;
  }
  getUsersFeeds(username, filter, function (err, urls) {
    if (err) {
      console.log(err);
      return res.send({});
    }
    const promises = urls.map(url => request(url));
    Promise.all(promises)
      .then(function (data) {
        for (let json of data) {
          parser.parseString(json, function (err, result) {
            JSONS.push(JSON.parse(JSON.stringify(result)));
          });
        }
      }).then(function (data) {
        res.send(JSONS);
      }).catch(function (error) {
        console.log(error);
        return;
      });
  });

});

app.post('/api/testUrl', function (req, res) {
  const { url } = req.body;
  let json = [];
  if(!url){
    return res.status(200).send({ errorMsg: false });
  }
  request(url)
    .then(function (data) {
      parser.parseString(data, function (err, result) {
        json = JSON.parse(JSON.stringify(result));
        console.log("json ", json);
        if (json.rss) {
          return res.status(200).send({ errorMsg: false });
        }
        return res.status(200).send({ errorMsg: 'Rss feeds not found' });
      });
      return false;
    })
    .catch(function (error) {
      return res.status(200).send({ errorMsg: error.message });
    });
});

app.post('/api/updateUsersCategories', function (req, res) {
  const { username, categories } = req.body;

  let check = categoryTitleCheck(categories);
  if (check.find(item => item)) {
    return res.status(401).send({ error: check });
  }

  const query = { 'username': username };
  const set = { 'categories': categories };
  userModel.update(query, set, function (err) {
    if (err) {
      res.status(401).send({ error: 'Error occured during saving feeds.' });
    } else {
      res.status(200).send({ error: false });
    }
  });
});
/*
  check if all categoryTitles is filled but the last
*/
function categoryTitleCheck(categories) {
  let check = [];
  for (const [index, category] of categories.entries()) {
    if ((!category.categoryTitle && category.categoryUrls[0] !== '')) {
      check.push('Urls withnout category can not be saved');
    } else {
      check.push(false);
    }
  }
  return check;
}

app.post('/api/signup', [
  check('username', 'Username is required.').custom((value, { req }) => value),
  check('password', 'Password must be at least 8 characters.').isLength({ min: 8 }),
  check('password', 'Passwords do not match.').custom((value, { req }) => value === req.body.password2)
], function (req, res) {

  const errors = validationResult(req);
  if (errors !== undefined && !errors.isEmpty()) {
    let error = errors.mapped();
    const errorMsg = error.username ? error.username.msg : error.password.msg;
    return res.status(401).json({ error: errorMsg });
  }

  let userInfo = {
    username: req.body.username,
    password: req.body.password,
    categories: [{
      categoryTitle: "",
      categoryUrls: [""]
    }]
  };

  let newUser = new userModel(userInfo);
  newUser.save(function (err) {
    if (err) {
      if (err.code === 11000) {
        return res.status(401).json({ error: "Username already exists." });
      }
      return res.status(401).json({ error: "Unexpected error. Please contact admin." });
    }
    userInfo._id = newUser._id;
    req.session.login(userInfo);
    return res.status(200).send({ error: false, username: userInfo.username, logged: true });
  });
});

app.post('/api/login', [
  check('username', 'Username is required.').custom((value, { req }) => value),
  check('password', 'Password is required.').custom((value, { req }) => value)
], async function (req, res) {

  const errors = validationResult(req);
  if (errors !== undefined && !errors.isEmpty()) {
    let error = errors.mapped();
    const errorMsg = error.username ? error.username.msg : error.password.msg;
    return res.status(401).json({ error: errorMsg });
  }

  const delayResponse = response => {
    setTimeout(() => {
      response();
    }, 1000);
  };

  const { username, password } = req.body;
  const { ip } = req;
  const identityKey = `${username}-${ip}`;
  const Logins = mongoose.model('logins', loginSchema);

  if (!await Logins.canAuthenticate(identityKey)) {
    return delayResponse(() => res.status(500).send({ error: "The account is temporarily locked out." }));
  }
  if (await Logins.inProgress(identityKey)) {
    return delayResponse(() => res.status(500).send({ error: "Login already in progress. Please wait." }));
  }

  const existingUser = await userModel.findOne({ username: username }).exec();
  if (existingUser && await existingUser.passwordIsValid(password)) {
    const userInfo = {
      _id: existingUser._id,
      username: existingUser.username,
      categories: existingUser.categories
    };

    req.session.login(userInfo);
    delete userInfo._id;
    userInfo.logged = true;
    await Logins.succesfulLoginAttempt(identityKey);
    return delayResponse(() => res.status(200).send(userInfo));
  } else {
    await Logins.failedLoginAttempt(identityKey);
    return delayResponse(() => res.status(401).send({ error: "Invalid username or password." }));
  }


});

app.get('/api/logout', function (req, res) {
  if (req.session && req.session.userInfo) {
    req.session.destroy();
    return res.status(200).send({});
  }
});


app.get('/api/loggedUser', function (req, res) {
  const sessionUserInfo = req.session.userInfo;
  if (sessionUserInfo !== undefined && sessionUserInfo.username) {
    userModel.findOne({ username: sessionUserInfo.username }, function (err, user) {
      if (err || !user) {
        return res.status(400).send({});
      }
      return res.status(200).send({
        username: user.username,
        categories: user.categories
      });

    });
  } else {
    return res.status(200).send({});
  }

});
app.get('*', function (req, res) {
  res.sendFile(path.join(__dirname, '../src/index.html'));
});
/*
const sslOptions = {
  key: fs.readFileSync('key.pem'),
  cert: fs.readFileSync('cert.pem'),
  passphrase: '1234'
};
 
https.createServer(sslOptions, app).listen(3000, function(err){
  if (err) {
    console.log(err);
  } else {
    open(`https://localhost:${port}`);
  }
});
*/
app.listen(port, function (err) {
  if (err) {
    console.log(err);
  } else {
    open(`http://localhost:${port}`);
  }
});

