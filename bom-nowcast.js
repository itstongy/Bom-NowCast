#!/usr/bin/env node
'use strict';

const { main } = require('./src/cli');

main(process.argv).catch((err) => {
  console.error(err && err.message ? err.message : err);
  process.exit(1);
});
