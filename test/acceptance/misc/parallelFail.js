describe('parallel failing', function () {

  this.parallel(10);
  var runs = 0;

  after(function (done) {
    runs.should.eql(7);
    done();
  })


  it('should fail (parent suite)', function (done) {
    setTimeout(function () {
      runs++;
      throw new Error('this is ok (parent)');
    }, 10);
  });

  describe('bailing suite 1', function () {

    this.bail(true);

    it('test 1-1', function (done) {
      runs++;
      setTimeout(done, 80);
    })

    it('should fail', function (done) {
      setTimeout(function () {
        setTimeout(function () {
          throw new Error('this is ok (1-2)');
        }, 20)
      }, 20)
    });

    it('should not run this', function (done) {
      throw new Error('we should have bailed');
    });

    after(function () {
      // after hook should still be called.
      runs++;
    })
  })

  describe('suite 2', function () {
    it('test 2-1', function (done) {
      runs++;
      setTimeout(done, 10);
    })

    describe("sub-suite", function () {
      it('should fail', function (done) {
        setTimeout(function () {
          throw new Error('this is ok (2-2)');
        }, 10);
      });

      it('should run this if not bailing', function () {
        runs++;
      })
    });

  })

  describe('suite 3', function () {
    it('test 3-1', function (done) {
      setTimeout(done, 80);
      runs++;
    })

    it('pending test');

    it('should fail by passing Error to done()', function (done) {
      setTimeout(function () {
        done(new Error('this is ok (3-2)'));
      }, 10)
    });
  })

  describe('suite 4 (failing hook)', function () {

    before(function (done) {
      throw new Error('this is ok (4-before)');
    })

    after(function (done) {
      //this should be called
      runs++;
      done();
    })

    it('test 4-1 (should not get here)', function (done) {
      setTimeout(done, 80);
      runs++;
    })

    it('pending test');

    it('should not get here (4-2)', function (done) {
      runs++;
      throw new Error("this should not be called")
    });
  })
})


describe('parallel no children', function () {

  this.parallel(true);

  it("should report after this", function () {});

});
