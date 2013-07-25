/**
 * Module dependencies.
 */

var EventEmitter = require('events').EventEmitter
  , async = require('async')
  , debug = require('debug')('mocha:runner')
  , Test = require('./test')
  , utils = require('./utils')
  , isNode = typeof window === 'undefined'
  , filter = utils.filter
  , keys = utils.keys;

/**
 * Non-enumerable globals.
 */

var globals = [
  'setTimeout',
  'clearTimeout',
  'setInterval',
  'clearInterval',
  'XMLHttpRequest',
  'Date'
];


var _events = [
  'start',
  'end',
  'suite',
  'suite end',
  'pending',
  'test',
  'test end',
  'hook',
  'hook end',
  'pass',
  'fail'
];

/**
 * Expose `Runner`.
 */

module.exports = Runner;

/**
 * Initialize a `Runner` for the given `suite`.
 *
 * Events:
 *
 *   - `start`  execution started
 *   - `end`  execution complete
 *   - `suite`  (suite) test suite execution started
 *   - `suite end`  (suite) all tests (and sub-suites) have finished
 *   - `pending`  (test) pending test encountered
 *   - `test`  (test) test execution started
 *   - `test end`  (test) test completed
 *   - `hook`  (hook) hook execution started
 *   - `hook end`  (hook) hook complete
 *   - `pass`  (test) test passed
 *   - `fail`  (test, err) test failed
 *   - `pending`  (test) test pending
 *
 * @api public
 */

function Runner(suite) {
  var self = this;
  this._globals = [];
  this.suite = suite;
  this.total = suite.total();
  this.failures = 0;
  this.on('test end', function(test){ self.checkGlobals(test); });
  this.on('hook end', function(hook){ self.checkGlobals(hook); });
  this.grep(/.*/);
  this.globals(this.globalProps().concat(['errno']));
}

/**
 * Wrapper for setImmediate, process.nextTick, or browser polyfill.
 *
 * @param {Function} fn
 * @api private
 */

Runner.immediately = global.setImmediate || process.nextTick;

/**
 * Inherit from `EventEmitter.prototype`.
 */

Runner.prototype.__proto__ = EventEmitter.prototype;

/**
 * Run tests with full titles matching `re`. Updates runner.total
 * with number of tests matched.
 *
 * @param {RegExp} re
 * @param {Boolean} invert
 * @return {Runner} for chaining
 * @api public
 */

Runner.prototype.grep = function(re, invert){
  debug('grep %s', re);
  this._grep = re;
  this._invert = invert;
  this.total = this.grepTotal(this.suite);
  return this;
};

/**
 * Returns the number of tests matching the grep search for the
 * given suite.
 *
 * @param {Suite} suite
 * @return {Number}
 * @api public
 */

Runner.prototype.grepTotal = function(suite) {
  var self = this;
  var total = 0;

  suite.eachTest(function(test){
    var match = self._grep.test(test.fullTitle());
    if (self._invert) match = !match;
    if (match) total++;
  });

  return total;
};

/**
 * Return a list of global properties.
 *
 * @return {Array}
 * @api private
 */

Runner.prototype.globalProps = function() {
  var props = utils.keys(global);

  return utils.uniq(props.concat(globals));
};

/**
 * Allow the given `arr` of globals.
 *
 * @param {Array} arr
 * @return {Runner} for chaining
 * @api public
 */

Runner.prototype.globals = function(arr){
  if (0 === arguments.length) return this._globals;
  utils.forEach(arr, function(arr){
    this._globals.push(arr);
  }, this);
  this._globals = utils.uniq(this._globals);
  return this;
};

/**
 * Check for global variable leaks.
 *
 * @api private
 */

Runner.prototype.checkGlobals = function(test){
  if (this.ignoreLeaks) return;
  test = test || this.test;
  var ok = this._globals
    , currGlobals = this.globalProps()
    , isNode = process.kill
    , leaks;

  // check length - 2 ('errno' and 'location' globals)
  if (isNode && 1 == ok.length - currGlobals.length) return;
  else if (2 == ok.length - currGlobals.length) return;

  leaks = filterLeaks(ok, currGlobals);
  this._globals = this._globals.concat(leaks);

  if (leaks.length > 1) {
    this.fail(test, new Error('global leaks detected: ' + leaks.join(', ') + ''));
  } else if (leaks.length) {
    this.fail(test, new Error('global leak detected: ' + leaks[0]));
  }
};

/**
 * Fail the given `test`.
 *
 * @param {Test} test
 * @param {Error} err
 * @api private
 */

Runner.prototype.fail = function(test, err){
  ++this.failures;
  test.state = 'failed';

  if ('string' == typeof err) {
    err = new Error('the string "' + err + '" was thrown, throw an Error :)');
  }

  this.emit('fail', test, err);
};

/**
 * Fail the given `hook` with `err`.
 *
 * Hook failures make the suite bail due
 * to that fact that a failing hook will
 * surely cause subsequent tests to fail.
 *
 * @param {Hook} hook
 * @param {Error} err
 * @api private
 */

Runner.prototype.failHook = function(hook, err){
  this.suite.bail(true);
  this.fail(hook, err);
};

/**
 * Run hook `name` callbacks and then invoke `fn()`.
 *
 * @param {String} name
 * @param {Function} function
 * @api private
 */

Runner.prototype.hook = function(name, fn){
  var suite = this.suite
    , hooks = suite['_' + name]
    , self = this
    , timer;

  // if we're bailing, only run hooks if this suite caused it, otherwise, skip
  if (suite.failures && suite.bail() && !suite.failSource &&
    name.indexOf('after') !== 0) return fn();

  function next(i) {
    var hook = hooks[i];
    if (!hook) return fn();
    self.currentRunnable = hook;

    hook.ctx.currentTest = self.test;

    self.emit('hook', hook);

    hook.on('error', function(err){
      self.failHook(hook, err);
    });

    // save a reference to next() in case the hook fails asyncronously
    self.next = next.bind(null, i + 1);

    hook.run(function(err){
      hook.removeAllListeners('error');
      var testError = hook.error();
      if (testError) self.fail(self.test, testError);
      if (err) {
        self.failHook(hook, err);
      } else {
        self.emit('hook end', hook);
      }
      next(++i);
    });
  }



  Runner.immediately(function(){
    next(0);
  });
};

/**
 * Run hook `name` for the given array of `suites`
 * in order, and callback `fn(err)`.
 *
 * @param {String} name
 * @param {Array} suites
 * @param {Function} fn
 * @api private
 */

Runner.prototype.hooks = function(name, runners, fn){

  function next(runner) {
    if (!runner) return fn();

    runner.hook(name, function(err){
      if (err) return fn(err);
      next(runners.pop());
    });
  }

  next(runners.pop());
};

/**
 * Run hooks from the top level down.
 *
 * @param {String} name
 * @param {Function} fn
 * @api private
 */

Runner.prototype.hookUp = function(name, fn){
  var runners = [this].concat(this.parents()).reverse();
  this.hooks(name, runners, fn);
};

/**
 * Run hooks from the bottom up.
 *
 * @param {String} name
 * @param {Function} fn
 * @api private
 */

Runner.prototype.hookDown = function(name, fn){
  var runners = [this].concat(this.parents());
  this.hooks(name, runners, fn);
};

/**
 * Return an array of parent Suites from
 * closest to furthest.
 *
 * @return {Array}
 * @api private
 */

Runner.prototype.parents = function(){
  var runner = this
    , runners = [];
  while (runner = runner.parent) runners.push(runner);
  return runners;
};

/**
 * Run the current test and callback `fn(err)`.
 *
 * @param {Function} fn
 * @api private
 */

Runner.prototype.runTest = function(fn){
  var test = this.test
    , self = this;

  if (this.asyncOnly) test.asyncOnly = true;

  try {
    test.on('error', function(err){
      self.fail(test, err);
    });
    test.run(fn);
  } catch (err) {
    fn(err);
  }
};

/**
 * Run tests in the given `suite` and invoke
 * the callback `fn()` when complete.
 *
 * @param {Suite} suite
 * @param {Function} fn
 * @api private
 */

Runner.prototype.runTests = function(suite, fn){
  var self = this
    , tests = suite.tests.slice()
    , test;

  function next(err) {
    // if we bail after first err
    if (suite.failures && suite._bail) return fn();

    // next test
    test = tests.shift();

    // all done
    if (!test) return fn();

    // grep
    var match = self._grep.test(test.fullTitle());
    if (self._invert) match = !match;
    if (!match) return next();

    // pending
    if (test.pending) {
      self.emit('pending', test);
      self.emit('test end', test);
      return next();
    }

    // execute test and hook(s)
    self.emit('test', self.test = test);
    self.hookDown('beforeEach', function(){
      self.currentRunnable = self.test;
      self.runTest(function(err){
        test = self.test;

        if (err) {
          self.fail(test, err);
          self.emit('test end', test);
          return self.hookUp('afterEach', next);
        }

        test.state = 'passed';
        self.emit('pass', test);
        self.emit('test end', test);
        self.hookUp('afterEach', next);
      });
    });
  }

  this.next = next;
  next();
};

/**
 * Run the given `suite` and invoke the
 * callback `fn()` when complete.
 *
 * @param {Suite} suite
 * @param {Function} fn
 * @api private
 */

Runner.prototype.runSuite = function(suite, fn){
  var total = this.grepTotal(suite)
    , self = this,
    runners = [];

  debug('run suite %s', suite.fullTitle());

  if (!total) return fn();

  this.emit('suite', suite);

  function suiteItr(suite, cb) {
    var runner = self.createRunner(suite);
    runners.push(runner);
    runner.run(function (failures) {
      self.failures += failures;
      cb(null);
    });
  }


  function done() {
    debug('suite done %s', suite.fullTitle());

    //self.listenUncaught();

    if(suite.fullTitle() === "parallel failing") {
      debugger;
    }

    self.hook('afterAll', function(){
      debug('suite end %s', suite.fullTitle());
      if (suite.parallel()) {
        self._rebroadcastAll(runners);
      }
      self.emit('suite end', suite);
      fn();
    });
  }

  function next() {
    self.currentRunnable = null;

    //self.unlistenUncaught();

    var parallelism = suite.parallel();
    if (suite.parallel() && isNode) { // cant run in parallel in the browser
      if (parallelism === true) { parallelism = 10; }
      async.eachLimit(suite.suites, parallelism, suiteItr, done);
    } else {
      async.eachSeries(suite.suites, suiteItr, done);
    }
  }

  this.on('fail', function(){
    suite.failSource = true;
    suite.fail();
  });

  this.hook('beforeAll', function(){
    self.runTests(suite, next);
  });

};

Runner.prototype.createRunner = function(suite) {
  var runner = new Runner(suite);
  runner.parent = this;
  runner.ignoreLeaks = this.ignoreLeaks;
  runner.asyncOnly = this.asyncOnly;
  runner.grep(this._grep, this._invert);
  runner.globals(this.globals());
  this._wrapEvents(runner);

  return runner;
};

/**
 * Wrap a child runner's events and rebroadcast.  Cache them and batch
 * rebroadcast at the end if we are running in parallel.
 */
Runner.prototype._wrapEvents = function(runner) {
  var self = this;
  runner.eventCache = [];
  _events.forEach(function (event) {
    runner.on(event, function (data, err) {
      if (self.suite.parallel()) {
        runner.eventCache.push({event: event, data: data, err: err});
      } else {
        self.emit(event, data, err);
      }
    });
  });
};

/**
 * Replay the cached events from child runners as if this runner emitted them
 * @param  {Array[Runner]} runners
 * @api private
 */
Runner.prototype._rebroadcastAll = function (runners) {
  var self = this;
  runners.forEach(function (runner) {
    runner.eventCache.forEach(function (cache) {
      self.emit(cache.event, cache.data, cache.err);
    });
  })
};

/**
 * Handle uncaught exceptions.
 *
 * @param {Error} err
 * @api private
 */

Runner.prototype.uncaught = function(err){
  debug('uncaught exception %s', err.message);
  var runnable = this.currentRunnable;
  debugger;
  if (!runnable || 'failed' == runnable.state) return;
  runnable.clearTimeout();
  err.uncaught = true;
  if ('hook' == runnable.type) this.suite.bail(true);
  this.fail(runnable, err);

  // recover from test
  if ('test' == runnable.type) {
    this.emit('test end', runnable);
    this.hookUp('afterEach', this.next);
    return;
  }

  // recover from hooks
  this.emit('hook end', runnable);
  this.next();
};

/**
 * Set up uncaught error listeners
 *
 * @api private *
 */
Runner.prototype.listenUncaught = function () {
  if (isNode) {
    // if this suite is to be run in parallel, then we have to create a domain
    // to sandbox errors
    if (!this.domain) this.domain = require('domain').create();
    this.domain.suiteName = this.suite.fullTitle();
    this.domain.on('error', this.uncaught);
  } else {
    // uncaught exception, works when all suites are serial
    process.on('uncaughtException', this.uncaught);
  }
}

/**
 * Tear down uncaught error listeners
 *
 * @api private
 */

Runner.prototype.unlistenUncaught = function () {
  if (this.domain) {
    //this.domain.removeListener('error', this.uncaught);
    //this.domain.suiteName = this.suite.fullTitle() + " OFF";
  } else {
    process.removeListener('uncaughtException', this.uncaught);
  }
}


/**
 * Run the root suite and invoke `fn(failures)`
 * on completion.
 *
 * @param {Function} fn
 * @return {Runner} for chaining
 * @api public
 */

Runner.prototype.run = function(fn){
  var self = this
    , domain;
  fn = fn || function(){};
  this.uncaught = this.uncaught.bind(this);

  function end() {
    debug('end runner: %s', self.suite.title);
    //Runner.immediately(self.unlistenUncaught.bind(self));
    fn(self.failures);
  }

  function start() {
    debug('start');

    // callback
    self.on('end', end);

    // run suites
    if (!self.suite.parent) self.emit('start');
    self.runSuite(self.suite, function(){
      debug('finished running');
      if (!self.suite.parent)
        self.emit('end');
      else {
        end();
      }
    });
  }

  this.listenUncaught();

  if(this.domain) {
    this.domain.run(start);
  } else {
    start();
  }

  return this;
};

/**
 * Filter leaks with the given globals flagged as `ok`.
 *
 * @param {Array} ok
 * @param {Array} globals
 * @return {Array}
 * @api private
 */

function filterLeaks(ok, globals) {
  return filter(globals, function(key){
    // Firefox and Chrome exposes iframes as index inside the window object
    if (/^d+/.test(key)) return false;
    var matched = filter(ok, function(ok){
      if (~ok.indexOf('*')) return !key.indexOf(ok.split('*')[0]);
      // Opera and IE expose global variables for HTML element IDs (issue #243)
      if (/^mocha-/.test(key)) return true;
      return key == ok;
    });
    return !matched.length && (!global.navigator || 'onerror' !== key);
  });
}
