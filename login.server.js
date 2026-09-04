/**
 * SSO-aware gate for the OTC console login widget (BSM handover build).
 *
 * The BSM instance (nomurabsmdev) authenticates users via SSO at the instance layer, so by the
 * time this Service Portal home/login page renders, a real user is already signed in. In that
 * case we skip the custom sign-in form entirely and forward straight to the landing. Only a
 * genuinely unauthenticated ("guest") visitor is shown the branded sign-in form, as a fallback.
 *
 * This keeps the app portable with no code change between environments:
 *   SSO instance (bsmdev)      -> user already authenticated -> form skipped, straight to landing
 *   non-SSO instance / logged-out -> guest session          -> branded sign-in form is shown
 */
(function () {
    data.redirect = '/nfotcbsm?id=bsm_work_drivers';

    // In Service Portal an unauthenticated visitor runs as the built-in "guest" user; a real
    // (SSO / platform) session returns the actual username. Use gs.getUserName() — the scoped-safe
    // GlideSystem call — NOT gs.getUser().getUserName() (the scoped ScopedUser has no getUserName()).
    var userName = gs.getUserName();
    data.authed = !!(userName && userName !== 'guest'); // real user -> skip the sign-in form
})();
