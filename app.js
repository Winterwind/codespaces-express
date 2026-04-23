require('dotenv').config();

var createError = require('http-errors');
var express = require('express');
var path = require('path');
var cookieParser = require('cookie-parser');
var logger = require('morgan');
var session = require('express-session');
var SequelizeStore = require('connect-session-sequelize')(session.Store);
var bcrypt = require('bcrypt');

var sequelize = require('./db');
var User = require('./models/User');

var app = express();

// ── View engine ───────────────────────────────────────────────────────────────
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'hbs');

// ── Core middleware ───────────────────────────────────────────────────────────
app.use(logger('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

// ── Sessions ──────────────────────────────────────────────────────────────────
var sessionStore = new SequelizeStore({ db: sequelize });

app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-secret-change-in-production',
  store: sessionStore,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 } // 1 week
}));

sessionStore.sync();

// ── Inject current user into every view ──────────────────────────────────────
app.use(async function (req, res, next) {
  if (req.session.userId) {
    try {
      var user = await User.findByPk(req.session.userId, {
        attributes: ['id', 'username', 'email']
      });
      if (user) {
        res.locals.currentUser = user;
        res.locals.avatarInitial = user.username[0].toUpperCase();
      }
    } catch (e) { /* ignore */ }
  }
  next();
});

// ── Auth guard ────────────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (!req.session.userId) return res.redirect('/login');
  next();
}

// ── Auth routes ───────────────────────────────────────────────────────────────

app.get('/', function (req, res) {
  res.redirect(req.session.userId ? '/profile' : '/login');
});

app.get('/login', function (req, res) {
  if (req.session.userId) return res.redirect('/profile');
  res.render('login', { title: 'Sign In', hideNav: true, bodyClass: 'auth-page' });
});

app.post('/login', async function (req, res) {
  var { email, password } = req.body;
  try {
    var user = await User.findOne({ where: { email } });
    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      return res.render('login', {
        title: 'Sign In', hideNav: true, bodyClass: 'auth-page',
        error: 'Invalid email or password.', email
      });
    }
    req.session.userId = user.id;
    res.redirect('/profile');
  } catch (e) {
    next(e);
  }
});

app.get('/register', function (req, res) {
  if (req.session.userId) return res.redirect('/profile');
  res.render('register', { title: 'Register', hideNav: true, bodyClass: 'auth-page' });
});

app.post('/register', async function (req, res, next) {
  var { username, email, password, confirm } = req.body;
  var renderErr = function (msg) {
    res.render('register', {
      title: 'Register', hideNav: true, bodyClass: 'auth-page',
      error: msg, username, email
    });
  };

  if (!username || !email || !password || !confirm) return renderErr('All fields are required.');
  if (password.length < 8) return renderErr('Password must be at least 8 characters.');
  if (password !== confirm) return renderErr('Passwords do not match.');
  if (!/^[a-zA-Z0-9_-]{3,20}$/.test(username)) {
    return renderErr('Username must be 3–20 characters and contain only letters, numbers, _ or -.');
  }

  try {
    var existing = await User.findOne({ where: { email } });
    if (existing) return renderErr('An account with that email already exists.');
    var takenUsername = await User.findOne({ where: { username } });
    if (takenUsername) return renderErr('That username is already taken.');

    var passwordHash = await bcrypt.hash(password, 12);
    var user = await User.create({ username, email, passwordHash });
    req.session.userId = user.id;
    res.redirect('/profile');
  } catch (e) {
    next(e);
  }
});

app.get('/logout', function (req, res, next) {
  req.session.destroy(function (err) {
    if (err) return next(err);
    res.redirect('/login');
  });
});

// ── Protected routes ──────────────────────────────────────────────────────────

app.get('/profile', requireAuth, function (req, res) {
  res.render('profile', { title: res.locals.currentUser.username });
});

app.get('/project/:id', requireAuth, function (req, res) {
  res.render('project', { title: 'Brand Refresh 2026' });
});

app.get('/task/:id', requireAuth, function (req, res) {
  res.render('task', { title: 'Task #1' });
});

app.get('/solution/:id', requireAuth, function (req, res) {
  res.render('solution', { title: 'Solution #1' });
});

// ── Error handling ────────────────────────────────────────────────────────────

app.use(function (req, res, next) {
  next(createError(404));
});

app.use(function (err, req, res, next) {
  res.locals.message = err.message;
  res.locals.error = req.app.get('env') === 'development' ? err : {};
  res.status(err.status || 500);
  res.render('error');
});

module.exports = app;
