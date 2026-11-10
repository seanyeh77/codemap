function helper() { return 1; }
exports.run = function () { return helper(); };
class Old {
  m() { return this.n(); }
  n() { return helper(); }
}
module.exports.Old = Old;
