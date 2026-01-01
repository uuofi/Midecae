module.exports = {
  apps: [
    {
      name: 'api.medicare-iq.com',
      script: 'server.js',
      cwd: __dirname,
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
