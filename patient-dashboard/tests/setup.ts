import '@testing-library/jest-dom';

// Default bootstrap config so any test that mounts App or useAuth without
// passing an explicit override gets a valid config.
window.__OPENEMR_DASHBOARD__ = {
  clientId: 'patient-dashboard-spa',
  redirectUri: 'http://localhost/cb',
  authorizeEndpoint: 'http://localhost/oauth2/default/authorize',
  tokenEndpoint: 'http://localhost/oauth2/default/token',
  scopes: ['openid', 'launch/patient', 'patient/Patient.rs', 'offline_access'],
};
