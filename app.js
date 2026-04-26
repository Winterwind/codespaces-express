require('dotenv').config();

const createError = require('http-errors');
const express = require('express');
const path = require('path');
const cookieParser = require('cookie-parser');
const logger = require('morgan');
const session = require('express-session');
const SequelizeStore = require('connect-session-sequelize')(session.Store);
const bcrypt = require('bcrypt');
const hbs = require('hbs');

const fs   = require('fs');
const { Op } = require('sequelize');
const sequelize = require('./db');
const multer = require('multer');
const { User, Project, ProjectMember, ProjectStar, Task, TaskAssignee, Solution, SolutionFile, Contribution } = require('./models/index');

const app = express();

// ── View engine ───────────────────────────────────────────────────────────────
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'hbs');

// ── Handlebars helpers ────────────────────────────────────────────────────────
hbs.registerHelper('formatDate', (date) => {
  if (!date) return '';
  const iso = new Date(date).toISOString();
  return new hbs.SafeString(
    `<time data-fmt="date" datetime="${iso}">${iso.slice(0, 10)}</time>`
  );
});

// Deterministic avatar colour class based on username
hbs.registerHelper('avatarColor', (username) => {
  const colors = ['c-av-teal', 'c-av-blue', 'c-av-green', 'c-av-purple'];
  let hash = 0;
  for (let i = 0; i < (username || '').length; i++) {
    hash = username.charCodeAt(i) + ((hash << 5) - hash);
  }
  return colors[Math.abs(hash) % colors.length];
});

hbs.registerHelper('initial', (str) => (str ? str[0].toUpperCase() : '?'));
hbs.registerHelper('eq',      (a, b) => a === b);
hbs.registerHelper('gt',      (a, b) => a > b);

hbs.registerHelper('formatSize', (bytes) => {
  if (!bytes) return '0 B';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
});

hbs.registerHelper('fileIconClass', (mime) => {
  if (!mime) return 'fi-doc';
  if (mime.startsWith('image/')) return 'fi-img';
  if (mime === 'application/pdf') return 'fi-pdf';
  if (mime.includes('zip') || mime.includes('compressed') || mime.includes('x-tar')) return 'fi-zip';
  return 'fi-doc';
});

hbs.registerHelper('fileIconLabel', (mime) => {
  if (!mime) return 'FILE';
  if (mime.startsWith('image/')) return 'IMG';
  if (mime === 'application/pdf') return 'PDF';
  if (mime.includes('zip') || mime.includes('compressed') || mime.includes('x-tar')) return 'ZIP';
  return 'FILE';
});

// ── File upload (multer) ──────────────────────────────────────────────────────
const uploadDir = path.join(__dirname, 'data', 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename:    (req, file, cb) => {
      const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
      cb(null, unique + path.extname(file.originalname));
    }
  }),
  limits: { fileSize: 10 * 1024 * 1024 } // 10 MB per file
});

// ── Core middleware ───────────────────────────────────────────────────────────
app.use(logger('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

// ── Sessions ──────────────────────────────────────────────────────────────────
const sessionStore = new SequelizeStore({ db: sequelize });

app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-secret-change-in-production',
  store: sessionStore,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 }
}));

sessionStore.sync();

// ── Inject current user into every view ──────────────────────────────────────
app.use(async (req, res, next) => {
  if (req.session.userId) {
    try {
      const user = await User.findByPk(req.session.userId, {
        attributes: ['id', 'username'/*, 'email'*/]
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
const requireAuth = (req, res, next) => {
  if (!req.session.userId) return res.redirect('/login');
  next();
};

// ── Auth routes ───────────────────────────────────────────────────────────────

app.get('/', (req, res) => {
  res.redirect(req.session.userId ? '/profile' : '/login');
});

app.get('/login', (req, res) => {
  if (req.session.userId) return res.redirect('/profile');
  res.render('login', { title: 'Sign In', hideNav: true, bodyClass: 'auth-page' });
});

app.post('/login', async (req, res, next) => {
  const { username, password } = req.body;
  try {
    const user = await User.findOne({ where: { username } });
    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      return res.render('login', {
        title: 'Sign In', hideNav: true, bodyClass: 'auth-page',
        error: 'Invalid username or password.', username
      });
    }
    req.session.userId = user.id;
    res.redirect('/profile');
  } catch (e) {
    next(e);
  }
});

app.get('/register', (req, res) => {
  if (req.session.userId) return res.redirect('/profile');
  res.render('register', { title: 'Register', hideNav: true, bodyClass: 'auth-page' });
});

app.post('/register', async (req, res, next) => {
  const { username, /*email,*/ password, confirm } = req.body;
  const renderErr = (msg) => res.render('register', {
    title: 'Register', hideNav: true, bodyClass: 'auth-page',
    error: msg, username/*, email*/
  });

  if (!username || /*!email ||*/ !password || !confirm) return renderErr('All fields are required.');
  if (password.length < 8)    return renderErr('Password must be at least 8 characters.');
  if (password !== confirm)   return renderErr('Passwords do not match.');
  if (!/^[a-zA-Z0-9_-]{3,20}$/.test(username)) {
    return renderErr('Username must be 3–20 characters and contain only letters, numbers, _ or -.');
  }

  try {
    // if (await User.findOne({ where: { email } }))    return renderErr('An account with that email already exists.');
    if (await User.findOne({ where: { username } })) return renderErr('That username is already taken.');

    const passwordHash = await bcrypt.hash(password, 12);
    const user = await User.create({ username, /*email,*/ passwordHash });
    req.session.userId = user.id;
    res.redirect('/profile');
  } catch (e) {
    next(e);
  }
});

app.get('/logout', (req, res, next) => {
  req.session.destroy((err) => {
    if (err) return next(err);
    res.redirect('/login');
  });
});

// ── Profile ───────────────────────────────────────────────────────────────────

app.get('/profile', requireAuth, async (req, res, next) => {
  try {
    const user = await User.findByPk(req.session.userId);

    // Fetch all projects the user is a member of (owned or invited)
    const memberships = await ProjectMember.findAll({ where: { userId: user.id } });
    const memberProjectIds = memberships.map(m => m.projectId);

    const projects = memberProjectIds.length > 0
      ? await Project.findAll({
          where: { id: { [Op.in]: memberProjectIds } },
          include: [
            { model: User, as: 'members', attributes: ['id'], through: { attributes: [] } },
            { model: User, as: 'owner', attributes: ['username'] }
          ],
          order: [['updatedAt', 'DESC']]
        })
      : [];

    const contributionCount = await Contribution.count({ where: { userId: user.id } });

    const starredProjects = await Project.findAll({
      include: [
        { model: User, as: 'starredBy', where: { id: user.id }, attributes: [], through: { attributes: [] } },
        { model: User, as: 'owner', attributes: ['username'] }
      ]
    });

    // Heatmap: per-day contribution counts for the last 364 days
    // Use local dates throughout so "today" matches the server's wall-clock date.
    // SQLite datetime(x,'localtime') converts stored UTC timestamps to local time
    // before strftime extracts the date, keeping both sides in sync.
    const heatNow  = new Date();
    const heatStart = new Date(heatNow.getFullYear(), heatNow.getMonth(), heatNow.getDate() - 364);

    const localDateKey = (d) =>
      d.getFullYear() + '-' +
      String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0');

    const heatRows = await Contribution.findAll({
      where: { userId: user.id, createdAt: { [Op.gte]: heatStart } },
      attributes: [
        [sequelize.fn('strftime', '%Y-%m-%d',
          sequelize.fn('datetime', sequelize.col('createdAt'), 'localtime')), 'day'],
        [sequelize.fn('COUNT', sequelize.col('id')), 'cnt']
      ],
      group: [sequelize.fn('strftime', '%Y-%m-%d',
        sequelize.fn('datetime', sequelize.col('createdAt'), 'localtime'))],
      raw: true
    });

    const heatDayMap = {};
    heatRows.forEach(r => { heatDayMap[r.day] = parseInt(r.cnt); });

    // Build exactly 364 entries using local dates: index 0 = 363 days ago, index 363 = today
    const heatmapData = [];
    for (let i = 363; i >= 0; i--) {
      const d = new Date(heatNow.getFullYear(), heatNow.getMonth(), heatNow.getDate() - i);
      heatmapData.push(heatDayMap[localDateKey(d)] || 0);
    }

    const yearContribCount = heatmapData.reduce((sum, v) => sum + v, 0);

    const plainProjects = projects.map(p => ({
      ...p.toJSON(),
      memberCount: p.members.length,
      isOwned: p.ownerId === user.id
    }));

    res.render('profile', {
      title: user.username,
      profileUser: user.toJSON(),
      projects: plainProjects,
      projectCount: plainProjects.length,
      contributionCount,
      yearContribCount,
      heatmapJson: JSON.stringify(heatmapData),
      starredProjects: starredProjects.map(p => p.toJSON()),
      starCount: starredProjects.length,
      pinnedProjects: plainProjects.slice(0, 3)
    });
  } catch (e) {
    next(e);
  }
});

// ── Projects ──────────────────────────────────────────────────────────────────

// IMPORTANT: /project/new must be defined before /project/:id
app.get('/project/new', requireAuth, (req, res) => {
  res.render('project-new', { title: 'New Project' });
});

app.post('/project', requireAuth, async (req, res, next) => {
  const { title, description } = req.body;
  if (!title || !title.trim()) {
    return res.render('project-new', {
      title: 'New Project',
      error: 'A project title is required.',
      description
    });
  }
  try {
    const project = await Project.create({
      title: title.trim(),
      description: description ? description.trim() : null,
      ownerId: req.session.userId
    });
    await ProjectMember.create({ userId: req.session.userId, projectId: project.id, role: 'owner' });
    res.redirect(`/project/${project.id}`);
  } catch (e) {
    next(e);
  }
});

app.get('/project/:id', requireAuth, async (req, res, next) => {
  try {
    const project = await Project.findByPk(req.params.id, {
      include: [
        { model: User, as: 'owner',   attributes: ['id', 'username'] },
        { model: User, as: 'members', attributes: ['id', 'username'], through: { attributes: ['role'] } }
      ]
    });
    if (!project) return next(createError(404));

    const isMember = project.members.some(m => m.id === req.session.userId);
    if (!isMember) {
      return res.status(403).render('error', { message: 'You are not a member of this project.', error: {} });
    }

    const isOwner   = project.ownerId === req.session.userId;
    const isStarred = !!(await ProjectStar.findOne({
      where: { userId: req.session.userId, projectId: project.id }
    }));

    const tasks = await Task.findAll({
      where: { projectId: project.id },
      include: [
        { model: User,     as: 'creator',   attributes: ['username'] },
        { model: User,     as: 'assignees', attributes: ['id', 'username'], through: { attributes: [] } },
        { model: Solution, as: 'solutions', attributes: ['id'] }
      ],
      order: [['createdAt', 'DESC']]
    });

    const solutions = await Solution.findAll({
      where: { projectId: project.id },
      include: [
        { model: User, as: 'submittedBy', attributes: ['username'] },
        { model: Task, as: 'task',        attributes: ['id', 'title'] }
      ],
      order: [['createdAt', 'DESC']]
    });

    // Contributors sorted by contribution count, with bar widths + chart data
    const now = new Date();
    const fiftySixDaysAgo = new Date(now);
    fiftySixDaysAgo.setDate(now.getDate() - 56);

    const rawContributors = await Promise.all(
      project.members.map(async (m) => {
        const count = await Contribution.count({ where: { userId: m.id, projectId: project.id } });

        // Fetch per-day counts for the last 56 days (covers 8 weeks + daily 30-day view)
        const dailyRows = await Contribution.findAll({
          where: {
            userId: m.id,
            projectId: project.id,
            createdAt: { [Op.gte]: fiftySixDaysAgo }
          },
          attributes: [
            [sequelize.fn('strftime', '%Y-%m-%d', sequelize.col('createdAt')), 'day'],
            [sequelize.fn('COUNT', sequelize.col('id')), 'cnt']
          ],
          group: [sequelize.fn('strftime', '%Y-%m-%d', sequelize.col('createdAt'))],
          raw: true
        });

        const dayMap = {};
        dailyRows.forEach(r => { dayMap[r.day] = parseInt(r.cnt); });

        // 30-day daily array (values only — labels generated client-side)
        const dailyData = [];
        for (let i = 29; i >= 0; i--) {
          const d = new Date(now); d.setDate(now.getDate() - i);
          const key = d.toISOString().slice(0, 10);
          dailyData.push(dayMap[key] || 0);
        }

        // 8-week weekly array (values only — labels generated client-side)
        const weeklyData = [];
        for (let w = 7; w >= 0; w--) {
          let weekTotal = 0;
          for (let d = 0; d < 7; d++) {
            const day = new Date(now); day.setDate(now.getDate() - (w * 7 + d));
            weekTotal += dayMap[day.toISOString().slice(0, 10)] || 0;
          }
          weeklyData.push(weekTotal);
        }

        return { username: m.username, userId: m.id, count, dailyData, weeklyData };
      })
    );
    rawContributors.sort((a, b) => b.count - a.count);
    const maxCount = rawContributors[0]?.count || 1;
    const contributors = rawContributors.map((c, i) => ({
      rank: i + 1,
      username: c.username,
      userId: c.userId,
      isProjectOwner: c.userId === project.ownerId,
      count: c.count,
      barPercent: maxCount > 0 ? Math.round((c.count / maxCount) * 100) : 0,
      chartDailyData:   JSON.stringify(c.dailyData),
      chartWeeklyData:  JSON.stringify(c.weeklyData)
    }));

    const openTaskCount   = tasks.filter(t => t.status === 'open').length;
    const closedTaskCount = tasks.filter(t => t.status === 'closed').length;

    res.render('project', {
      title: project.title,
      project: project.toJSON(),
      isOwner,
      isStarred,
      tasks: tasks.map(t => {
        const p = t.toJSON();
        p.solutionCount = p.solutions ? p.solutions.length : 0;
        p.isOpen = p.status === 'open';
        return p;
      }),
      solutions: solutions.map(s => {
        const p = s.toJSON();
        p.isPending  = p.status === 'pending';
        p.isApproved = p.status === 'approved';
        p.isRejected = p.status === 'rejected';
        return p;
      }),
      contributors,
      hasTasks:        tasks.length > 0,
      hasSolutions:    solutions.length > 0,
      hasContributors: contributors.length > 0,
      taskCount:    tasks.length,
      openTaskCount,
      closedTaskCount,
      solutionCount: solutions.length,
      memberCount:   project.members.length,
      inviteError:   req.query.inviteError || null
    });
  } catch (e) {
    next(e);
  }
});

app.get('/project/:id/edit', requireAuth, async (req, res, next) => {
  try {
    const project = await Project.findByPk(req.params.id);
    if (!project) return next(createError(404));
    if (project.ownerId !== req.session.userId) {
      return res.status(403).render('error', { message: 'Only the project owner can edit this project.', error: {} });
    }
    res.render('project-edit', { title: 'Edit Project', project: project.toJSON() });
  } catch (e) {
    next(e);
  }
});

app.post('/project/:id/edit', requireAuth, async (req, res, next) => {
  const { title, description } = req.body;
  try {
    const project = await Project.findByPk(req.params.id);
    if (!project) return next(createError(404));
    if (project.ownerId !== req.session.userId) {
      return res.status(403).render('error', { message: 'Only the project owner can edit this project.', error: {} });
    }
    if (!title || !title.trim()) {
      return res.render('project-edit', {
        title: 'Edit Project', project: project.toJSON(),
        error: 'A project title is required.'
      });
    }
    await project.update({ title: title.trim(), description: description ? description.trim() : null });
    await Contribution.create({
      type: 'project_edited', referenceId: null,
      userId: req.session.userId, projectId: project.id
    });
    res.redirect(`/project/${project.id}`);
  } catch (e) {
    next(e);
  }
});

app.post('/project/:id/delete', requireAuth, async (req, res, next) => {
  try {
    const project = await Project.findByPk(req.params.id);
    if (!project) return next(createError(404));
    if (project.ownerId !== req.session.userId) {
      return res.status(403).render('error', { message: 'Only the project owner can delete this project.', error: {} });
    }
    await project.destroy();
    res.redirect('/profile');
  } catch (e) {
    next(e);
  }
});

app.post('/project/:id/star', requireAuth, async (req, res, next) => {
  try {
    await ProjectStar.findOrCreate({ where: { userId: req.session.userId, projectId: req.params.id } });
    res.redirect(`/project/${req.params.id}`);
  } catch (e) { next(e); }
});

app.post('/project/:id/unstar', requireAuth, async (req, res, next) => {
  try {
    await ProjectStar.destroy({ where: { userId: req.session.userId, projectId: req.params.id } });
    res.redirect(`/project/${req.params.id}`);
  } catch (e) { next(e); }
});

app.post('/project/:id/invite', requireAuth, async (req, res, next) => {
  const { username } = req.body;
  const projectId = req.params.id;
  const fail = (msg) => res.redirect(`/project/${projectId}?inviteError=${encodeURIComponent(msg)}`);

  try {
    const project = await Project.findByPk(projectId);
    if (!project) return next(createError(404));
    if (project.ownerId !== req.session.userId) {
      return res.status(403).render('error', { message: 'Only the project owner can invite members.', error: {} });
    }
    if (!username || !username.trim()) return fail('Please enter a username.');

    const invitee = await User.findOne({ where: { username: username.trim() } });
    if (!invitee) return fail('No user found with that username.');
    if (invitee.id === req.session.userId) return fail('You are already a member of this project.');

    const existing = await ProjectMember.findOne({ where: { userId: invitee.id, projectId } });
    if (existing) return fail(`${invitee.username} is already a member of this project.`);

    await ProjectMember.create({ userId: invitee.id, projectId, role: 'member' });
    res.redirect(`/project/${projectId}`);
  } catch (e) { next(e); }
});

app.post('/project/:id/remove-member', requireAuth, async (req, res, next) => {
  const { userId } = req.body;
  const projectId = req.params.id;

  try {
    const project = await Project.findByPk(projectId);
    if (!project) return next(createError(404));
    if (project.ownerId !== req.session.userId) {
      return res.status(403).render('error', { message: 'Only the project owner can remove members.', error: {} });
    }
    const targetId = parseInt(userId);
    if (targetId === project.ownerId) return res.redirect(`/project/${projectId}`);

    await ProjectMember.destroy({ where: { userId: targetId, projectId } });
    // Also clean up their stars on this project
    await ProjectStar.destroy({ where: { userId: targetId, projectId } });
    res.redirect(`/project/${projectId}`);
  } catch (e) { next(e); }
});

// ── Tasks ─────────────────────────────────────────────────────────────────────

app.get('/project/:id/task/new', requireAuth, async (req, res, next) => {
  try {
    const project = await Project.findByPk(req.params.id, {
      include: [{ model: User, as: 'members', attributes: ['id', 'username'], through: { attributes: [] } }]
    });
    if (!project) return next(createError(404));
    const isMember = project.members.some(m => m.id === req.session.userId);
    if (!isMember) {
      return res.status(403).render('error', { message: 'You are not a member of this project.', error: {} });
    }
    res.render('task-new', {
      title: 'New Task',
      project: project.toJSON(),
      members: project.members.map(m => m.toJSON())
    });
  } catch (e) { next(e); }
});

app.post('/project/:id/task', requireAuth, async (req, res, next) => {
  const { title, description } = req.body;
  let assigneeIds = req.body.assignees || [];
  if (!Array.isArray(assigneeIds)) assigneeIds = [assigneeIds];
  assigneeIds = assigneeIds.map(id => parseInt(id)).filter(Boolean);

  try {
    const project = await Project.findByPk(req.params.id, {
      include: [{ model: User, as: 'members', attributes: ['id', 'username'], through: { attributes: [] } }]
    });
    if (!project) return next(createError(404));
    const isMember = project.members.some(m => m.id === req.session.userId);
    if (!isMember) {
      return res.status(403).render('error', { message: 'You are not a member of this project.', error: {} });
    }

    if (!title || !title.trim()) {
      return res.render('task-new', {
        title: 'New Task',
        project: project.toJSON(),
        members: project.members.map(m => m.toJSON()),
        error: 'A task title is required.',
        description
      });
    }

    const task = await Task.create({
      title: title.trim(),
      description: description ? description.trim() : null,
      status: 'open',
      projectId: project.id,
      createdById: req.session.userId
    });

    // Assign selected members (validate they are project members)
    const validMemberIds = project.members.map(m => m.id);
    const validAssignees = assigneeIds.filter(id => validMemberIds.includes(id));
    await Promise.all(validAssignees.map(userId =>
      TaskAssignee.create({ taskId: task.id, userId })
    ));

    // Log contribution for the task creator
    await Contribution.create({
      type: 'task_created',
      referenceId: task.id,
      userId: req.session.userId,
      projectId: project.id
    });

    res.redirect(`/task/${task.id}`);
  } catch (e) { next(e); }
});

app.get('/task/:id', requireAuth, async (req, res, next) => {
  try {
    const task = await Task.findByPk(req.params.id, {
      include: [
        { model: User,    as: 'creator',   attributes: ['id', 'username'] },
        { model: User,    as: 'assignees', attributes: ['id', 'username'], through: { attributes: [] } },
        { model: Project, as: 'project',   attributes: ['id', 'title', 'ownerId'] }
      ]
    });
    if (!task) return next(createError(404));

    const membership = await ProjectMember.findOne({
      where: { userId: req.session.userId, projectId: task.projectId }
    });
    if (!membership) {
      return res.status(403).render('error', { message: 'You are not a member of this project.', error: {} });
    }

    const solutions = await Solution.findAll({
      where: { taskId: task.id },
      include: [{ model: User, as: 'submittedBy', attributes: ['username'] }],
      order: [['createdAt', 'DESC']]
    });

    const isOwner = task.project.ownerId === req.session.userId;
    const isOpen  = task.status === 'open';

    res.render('task', {
      title: task.title,
      task: task.toJSON(),
      isOwner,
      isOpen,
      solutions: solutions.map(s => ({
        ...s.toJSON(),
        isApproved: s.status === 'approved',
        isPending:  s.status === 'pending'
      })),
      hasSolutions:  solutions.length > 0,
      solutionCount: solutions.length
    });
  } catch (e) { next(e); }
});

app.post('/task/:id/close', requireAuth, async (req, res, next) => {
  try {
    const task = await Task.findByPk(req.params.id, {
      include: [{ model: Project, as: 'project', attributes: ['ownerId'] }]
    });
    if (!task) return next(createError(404));
    if (task.project.ownerId !== req.session.userId) {
      return res.status(403).render('error', { message: 'Only the project owner can close tasks.', error: {} });
    }
    await task.update({ status: 'closed' });
    res.redirect(`/task/${task.id}`);
  } catch (e) { next(e); }
});

app.post('/task/:id/reopen', requireAuth, async (req, res, next) => {
  try {
    const task = await Task.findByPk(req.params.id, {
      include: [{ model: Project, as: 'project', attributes: ['ownerId'] }]
    });
    if (!task) return next(createError(404));
    if (task.project.ownerId !== req.session.userId) {
      return res.status(403).render('error', { message: 'Only the project owner can reopen tasks.', error: {} });
    }
    await task.update({ status: 'open' });
    res.redirect(`/task/${task.id}`);
  } catch (e) { next(e); }
});

// ── Solutions ─────────────────────────────────────────────────────────────────

// IMPORTANT: /solution/new must be defined before /solution/:id
app.get('/solution/new', requireAuth, async (req, res, next) => {
  const { taskId, projectId } = req.query;
  if (!taskId || !projectId) return next(createError(400));
  try {
    const task = await Task.findByPk(taskId, {
      include: [{ model: Project, as: 'project', attributes: ['id', 'title', 'ownerId'] }]
    });
    if (!task || task.projectId !== parseInt(projectId)) return next(createError(404));
    if (task.status !== 'open') {
      return res.status(400).render('error', { message: 'Cannot submit a solution to a closed task.', error: {} });
    }
    const membership = await ProjectMember.findOne({ where: { userId: req.session.userId, projectId: task.projectId } });
    if (!membership) {
      return res.status(403).render('error', { message: 'You are not a member of this project.', error: {} });
    }
    res.render('solution-new', { title: 'New Solution', task: task.toJSON() });
  } catch (e) { next(e); }
});

app.post('/solution', requireAuth, upload.array('files', 5), async (req, res, next) => {
  const { title, description, taskId } = req.body;
  const cleanupFiles = () => (req.files || []).forEach(f => fs.unlink(f.path, () => {}));

  try {
    const task = await Task.findByPk(taskId, {
      include: [{ model: Project, as: 'project', attributes: ['id', 'title', 'ownerId'] }]
    });
    if (!task) { cleanupFiles(); return next(createError(404)); }
    if (task.status !== 'open') {
      cleanupFiles();
      return res.status(400).render('error', { message: 'Cannot submit a solution to a closed task.', error: {} });
    }
    const membership = await ProjectMember.findOne({ where: { userId: req.session.userId, projectId: task.projectId } });
    if (!membership) {
      cleanupFiles();
      return res.status(403).render('error', { message: 'You are not a member of this project.', error: {} });
    }
    if (!title || !title.trim()) {
      cleanupFiles();
      return res.render('solution-new', {
        title: 'New Solution', task: task.toJSON(),
        error: 'A solution title is required.', description
      });
    }
    const solution = await Solution.create({
      title: title.trim(),
      description: description ? description.trim() : null,
      status: 'pending',
      taskId: task.id,
      projectId: task.projectId,
      submittedById: req.session.userId
    });
    if (req.files && req.files.length > 0) {
      await Promise.all(req.files.map(f => SolutionFile.create({
        filename:     f.filename,
        originalName: f.originalname,
        mimeType:     f.mimetype,
        size:         f.size,
        solutionId:   solution.id
      })));
    }
    await Contribution.create({
      type: 'solution_submitted', referenceId: solution.id,
      userId: req.session.userId, projectId: task.projectId
    });
    res.redirect(`/solution/${solution.id}`);
  } catch (e) { cleanupFiles(); next(e); }
});

app.get('/solution/:id', requireAuth, async (req, res, next) => {
  try {
    const solution = await Solution.findByPk(req.params.id, {
      include: [
        { model: User,         as: 'submittedBy', attributes: ['id', 'username'] },
        { model: Task,         as: 'task',        attributes: ['id', 'title', 'status'] },
        { model: Project,      as: 'project',     attributes: ['id', 'title', 'ownerId'] },
        { model: SolutionFile, as: 'files' }
      ]
    });
    if (!solution) return next(createError(404));
    const membership = await ProjectMember.findOne({ where: { userId: req.session.userId, projectId: solution.projectId } });
    if (!membership) {
      return res.status(403).render('error', { message: 'You are not a member of this project.', error: {} });
    }
    const isOwner      = solution.project.ownerId === req.session.userId;
    const isSubmitter  = solution.submittedById === req.session.userId;
    const isPending    = solution.status === 'pending';
    const isApproved   = solution.status === 'approved';
    const isRejected   = solution.status === 'rejected';
    res.render('solution', {
      title: solution.title,
      solution: solution.toJSON(),
      isOwner, isSubmitter,
      canDeleteFiles: isOwner || isSubmitter,
      isPending, isApproved, isRejected,
      hasFiles: solution.files.length > 0
    });
  } catch (e) { next(e); }
});

app.post('/solution/:id/approve', requireAuth, async (req, res, next) => {
  try {
    const solution = await Solution.findByPk(req.params.id, {
      include: [{ model: Project, as: 'project', attributes: ['ownerId'] }]
    });
    if (!solution) return next(createError(404));
    if (solution.project.ownerId !== req.session.userId) {
      return res.status(403).render('error', { message: 'Only the project owner can approve solutions.', error: {} });
    }
    await solution.update({ status: 'approved' });
    await Task.update({ status: 'closed' }, { where: { id: solution.taskId } });
    res.redirect(`/solution/${solution.id}`);
  } catch (e) { next(e); }
});

app.post('/solution/:id/reject', requireAuth, async (req, res, next) => {
  try {
    const solution = await Solution.findByPk(req.params.id, {
      include: [{ model: Project, as: 'project', attributes: ['ownerId'] }]
    });
    if (!solution) return next(createError(404));
    if (solution.project.ownerId !== req.session.userId) {
      return res.status(403).render('error', { message: 'Only the project owner can reject solutions.', error: {} });
    }
    await solution.update({ status: 'rejected' });
    res.redirect(`/solution/${solution.id}`);
  } catch (e) { next(e); }
});

// ── Solution file routes ──────────────────────────────────────────────────────

app.get('/solution/:id/file/:fileId', requireAuth, async (req, res, next) => {
  try {
    const file = await SolutionFile.findByPk(req.params.fileId, {
      include: [{ model: Solution, as: 'solution', attributes: ['id', 'projectId'] }]
    });
    if (!file || String(file.solution.id) !== req.params.id) return next(createError(404));

    const membership = await ProjectMember.findOne({
      where: { userId: req.session.userId, projectId: file.solution.projectId }
    });
    if (!membership) {
      return res.status(403).render('error', { message: 'Access denied.', error: {} });
    }

    const filePath = path.join(uploadDir, file.filename);
    res.download(filePath, file.originalName);
  } catch (e) { next(e); }
});

app.post('/solution/:id/file/:fileId/delete', requireAuth, async (req, res, next) => {
  try {
    const file = await SolutionFile.findByPk(req.params.fileId, {
      include: [{
        model: Solution, as: 'solution',
        attributes: ['id', 'projectId', 'submittedById'],
        include: [{ model: Project, as: 'project', attributes: ['ownerId'] }]
      }]
    });
    if (!file || String(file.solution.id) !== req.params.id) return next(createError(404));

    const isOwner     = file.solution.project.ownerId  === req.session.userId;
    const isSubmitter = file.solution.submittedById     === req.session.userId;
    if (!isOwner && !isSubmitter) {
      return res.status(403).render('error', { message: 'You cannot delete this file.', error: {} });
    }

    fs.unlink(path.join(uploadDir, file.filename), () => {});
    await file.destroy();
    res.redirect(`/solution/${req.params.id}`);
  } catch (e) { next(e); }
});

// ── Error handling ────────────────────────────────────────────────────────────

app.use((req, res, next) => {
  next(createError(404));
});

app.use((err, req, res, next) => {
  res.locals.message = err.message;
  res.locals.error = req.app.get('env') === 'development' ? err : {};
  res.status(err.status || 500);
  res.render('error');
});

module.exports = app;
