var { Sequelize } = require('sequelize');
var path = require('path');

var sequelize = new Sequelize({
  dialect: 'sqlite',
  storage: path.join(__dirname, 'data', 'dev.sqlite'),
  logging: false
});

module.exports = sequelize;
