api.controller = function ($scope, $http, $window, spUtil) {
    var c = this;
    c.username = '';
    c.password = '';
    c.message = '';
    c.busy = false;

    var HOME = '/nfotcbsm?id=bsm_work_drivers';

    // SSO short-circuit: if already authenticated (server sets c.data.authed), skip the form.
    if (c.data && c.data.authed) {
        $window.location = c.data.redirect || HOME;
        return;
    }

    c.login = function (username, password) {
        if (!username || !password) {
            c.message = 'Please enter your username and password.';
            return;
        }
        c.busy = true;
        c.message = '';

        var url = spUtil.getURL({ sysparm_type: 'view_form.login' });
        var body = {
            sysparm_type: 'login',
            'ni.nolog.user_password': true,
            remember_me: true,
            user_name: username,
            user_password: password,
            get_redirect_url: true,
            is_direct_redirect: true,
            sysparm_goto_url: HOME,
            cert_login: false
        };
        var enc = Object.keys(body).map(function (k) {
            return encodeURIComponent(k) + '=' + encodeURIComponent(body[k]);
        }).join('&');

        $http({
            method: 'post',
            url: url,
            data: enc,
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        }).then(function (res) {
            c.busy = false;
            var d = res.data || {};
            if (d.status === 'success') {
                $window.location = d.redirect_url || HOME;
            } else if (d.status === 'mfa_code_required') {
                $window.location = '/validate_multifactor_auth_code.do';
            } else {
                c.message = d.message || 'Invalid username or password.';
                c.password = '';
            }
        }, function () {
            c.busy = false;
            c.message = 'Sign-in failed. Please try again.';
        });
    };
};
