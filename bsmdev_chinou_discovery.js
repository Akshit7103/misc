// ============================================================================
// bsmdev — Chinou discovery. Run in Scripts - Background, application scope = Global.
// Read-only. Masks any secret values. Tells us how Chinou is already wired on bsmdev
// so we can reuse it for a Global ChinouClient.
// ============================================================================
(function () {

  gs.info('=== chinou.* system properties ===');
  var p = new GlideRecord('sys_properties');
  p.addQuery('name', 'STARTSWITH', 'chinou');
  p.orderBy('name');
  p.query();
  var pc = 0;
  while (p.next()) {
    pc++;
    var n = p.getValue('name');
    var v = p.getValue('value');
    if (/pass|pwd|token|secret|key|credential/i.test(n)) {
      v = '(hidden, len=' + ('' + v).length + ')';
    }
    gs.info('  ' + n + ' = ' + v);
  }
  gs.info('  (chinou.* properties found: ' + pc + ')');

  gs.info('=== REST messages containing "chinou" ===');
  var r = new GlideRecord('sys_rest_message');
  r.addQuery('name', 'CONTAINS', 'hinou');
  r.query();
  var rc = 0;
  while (r.next()) {
    rc++;
    gs.info('  REST Message: ' + r.getValue('name') + ' | scope=' + r.getValue('sys_scope'));
  }
  gs.info('  (rest messages found: ' + rc + ')');

  gs.info('=== all ChinouClient script includes (any scope) ===');
  var s = new GlideRecord('sys_script_include');
  s.addQuery('name', 'ChinouClient');
  s.query();
  var sc = 0;
  while (s.next()) {
    sc++;
    gs.info('  SI: ' + s.getValue('api_name') + ' | access=' + s.getValue('access') + ' | active=' + s.getValue('active'));
  }
  gs.info('  (ChinouClient script includes found: ' + sc + ')');

  gs.info('=== DONE ===');
})();
