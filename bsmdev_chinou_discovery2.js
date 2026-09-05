// ============================================================================
// bsmdev — Chinou discovery v2. Run in Scripts - Background, scope = Global.
// Read-only, masks secrets. Digs into the existing "Chinou API" REST Message so we
// can decide whether to REUSE it for a Global ChinouClient.
// ============================================================================
(function () {

  gs.info('=== properties CONTAINING "chinou" (scope-aware) ===');
  var p = new GlideRecord('sys_properties');
  p.addQuery('name', 'CONTAINS', 'chinou');
  p.orderBy('name');
  p.query();
  var pc = 0;
  while (p.next()) {
    pc++;
    var n = p.getValue('name');
    var v = p.getValue('value');
    if (/pass|pwd|token|secret|key|credential/i.test(n)) { v = '(hidden, len=' + ('' + v).length + ')'; }
    gs.info('  ' + n + ' = ' + v);
  }
  gs.info('  (' + pc + ' found)');

  gs.info('=== Chinou REST Message(s) + scope + functions ===');
  var r = new GlideRecord('sys_rest_message');
  r.addQuery('name', 'CONTAINS', 'hinou');
  r.query();
  while (r.next()) {
    var scopeId = r.getValue('sys_scope');
    var scName = scopeId;
    var sc = new GlideRecord('sys_scope');
    if (sc.get(scopeId)) { scName = sc.getValue('scope') + '  (' + sc.getValue('name') + ')'; }
    gs.info('  REST Message: "' + r.getValue('name') + '"');
    gs.info('    scope  = ' + scName);
    gs.info('    access = ' + r.getValue('access'));
    gs.info('    sys_id = ' + r.getUniqueValue());
    var fn = new GlideRecord('sys_rest_message_fn');
    fn.addQuery('rest_message', r.getUniqueValue());
    fn.query();
    while (fn.next()) {
      var ep = fn.getValue('rest_endpoint') || '';
      var host = ep.replace(/(https?:\/\/[^\/]+).*/, '$1');   // host only, hide path
      gs.info('    function: "' + fn.getValue('function_name') + '"'
        + ' | method=' + fn.getValue('http_method')
        + ' | host=' + (host || '(inherits parent)')
        + ' | use_mid_server=' + fn.getValue('use_mid_server')
        + ' | mid_server=' + fn.getValue('mid_server')
        + ' | auth=' + fn.getValue('authentication_type'));
    }
  }

  gs.info('=== DONE ===');
})();
