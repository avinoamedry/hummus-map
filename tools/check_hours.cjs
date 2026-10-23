// קורא מערך JSON של ערכי opening_hours מ-stdin ומדפיס {ערך: {error, warnings}}.
const OH = require('opening_hours');
const values = JSON.parse(require('fs').readFileSync(0, 'utf8'));
const nominatim = { lat: 50, lon: 14.4, address: { country_code: 'cz', state: '' } };
const out = {};
for (const v of values) {
  try {
    const oh = new OH(v, nominatim);
    out[v] = { error: null, warnings: oh.getWarnings().length };
  } catch (e) {
    out[v] = { error: String(e).split('\n')[0], warnings: 0 };
  }
}
process.stdout.write(JSON.stringify(out));
