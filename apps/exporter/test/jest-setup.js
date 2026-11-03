// Runs before every test file. The toolbox ConfigService loads `.env.$NODE_ENV` (and throws when it is missing)
// unless GH_ENV is set, so tests opt out of file loading here and set the GH_* variables they need themselves.
process.env.GH_ENV = process.env.GH_ENV || 'test';
