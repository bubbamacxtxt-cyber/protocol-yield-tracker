const fs = require('fs');
const data = JSON.parse(fs.readFileSync('data.json', 'utf8'));
const template = fs.readFileSync('template.html', 'utf8');

for (const [name, whale] of Object.entries(data.whales)) {
    const positions = whale.positions || [];
    const vaults = whale.vaults || null;
    let html = template.replace('[WHALE_DATA_PLACEHOLDER]', JSON.stringify(positions));
    html = html.replace('VAULT_DATA_PLACEHOLDER', JSON.stringify(vaults || {}));
    html = html.replace(/WHALE_NAME/g, name);
    const safeName = name.toLowerCase().replace(/[^a-z0-9]/g, '');
    html = html.replace(/WHALE_FILENAME/g, safeName);
    fs.writeFileSync(name + '.html', html);
}
console.log('Pages rebuilt with vault data');
