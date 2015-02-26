var util = require("../../../util");
var t    = require("../../../types");

exports.check = t.isRestElement;

var memberExpressionVisitor = {
  enter(node, parent, scope, state) {
    if (t.isScope(node, parent) && !scope.bindingIdentifierEquals(state.name, state.outerDeclar)) {
      return this.skip();
    }

    if (t.isFunctionDeclaration(node) || t.isFunctionExpression(node)) {
      state.isOptimizable = false;
      return this.stop();
    }

    if (!t.isReferencedIdentifier(node, parent, { name: state.name })) return;

    if (t.isMemberExpression(parent)) {
      var prop = parent.property;
      if (typeof prop.value === "number" ||
          t.isUnaryExpression(prop) ||
          t.isBinaryExpression(prop)) {
        state.candidates.push({ node, parent });
        return;
      }
    }

    state.isOptimizable = false;
    this.stop();
  }
};

function optimizeMemberExpression(node, parent, offset) {
  var newExpr;
  var prop = parent.property;

  if (t.isLiteral(prop)) {
    node.name = "arguments";
    prop.value += offset;
    prop.raw = String(prop.value);
  } else {
    node.name = "arguments";
    newExpr = t.binaryExpression("+", prop, t.literal(offset));
    parent.property = newExpr;
  }
}

var hasRest = function (node) {
  return t.isRestElement(node.params[node.params.length - 1]);
};

exports.Function = function (node, parent, scope) {
  if (!hasRest(node)) return;

  var rest = node.params.pop().argument;

  var argsId = t.identifier("arguments");

  // otherwise `arguments` will be remapped in arrow functions
  argsId._ignoreAliasFunctions = true;

  // support patterns
  if (t.isPattern(rest)) {
    var pattern = rest;
    rest = scope.generateUidIdentifier("ref");
    var declar = t.variableDeclaration("var", pattern.elements.map(function (elem, index) {
      var accessExpr = t.memberExpression(rest, t.literal(index), true);
      return t.variableDeclarator(elem, accessExpr);
    }));
    node.body.body.unshift(declar);
  }

  // check if rest is used only in member expressions
  var restOuterDeclar = scope.getBindingIdentifier(rest.name);
  var state = {
    name: rest.name,
    outerDeclar: restOuterDeclar,
    isOptimizable: true,
    candidates: []
  };
  scope.traverse(node, memberExpressionVisitor, state);

  if (state.isOptimizable) {
    for (let i = 0, count = state.candidates.length; i < count; ++i) {
      let candidate = state.candidates[i];
      optimizeMemberExpression(candidate.node, candidate.parent, node.params.length, state.strictMode);
    }
    return;
  }

  var start = t.literal(node.params.length);
  var key = scope.generateUidIdentifier("key");
  var len = scope.generateUidIdentifier("len");

  var arrKey = key;
  var arrLen = len;
  if (node.params.length) {
    // this method has additional params, so we need to subtract
    // the index of the current argument position from the
    // position in the array that we want to populate
    arrKey = t.binaryExpression("-", key, start);

    // we need to work out the size of the array that we're
    // going to store all the rest parameters
    //
    // we need to add a check to avoid constructing the array
    // with <0 if there are less arguments than params as it'll
    // cause an error
    arrLen = t.conditionalExpression(
      t.binaryExpression(">", len, start),
      t.binaryExpression("-", len, start),
      t.literal(0)
    );
  }

  scope.assignTypeGeneric(rest.name, "Array");

  var loop = util.template("rest", {
    ARGUMENTS: argsId,
    ARRAY_KEY: arrKey,
    ARRAY_LEN: arrLen,
    START: start,
    ARRAY: rest,
    KEY: key,
    LEN: len,
  });
  loop._blockHoist = node.params.length + 1;
  node.body.body.unshift(loop);
};