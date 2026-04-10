#!/usr/bin/env node
const https = require('https');
const WALLET = '0x7bee8D37FBA61a6251a08b957d502C56E2A50FAb';
require('dotenv').config();
const DEBANK_KEY = process.env.DEBANK_API_KEY;

const url = `https://pro-openapi.debank.com/v1/user/complex_protocol_list?id=${WALLET}`;

const req = https.request(url, {
  method: 'GET',
  headers: { 'Accept': 'application/json', 'AccessKey': DEBANK_KEY }
}, res => {
  let body = '';
  res.on('data', d => body += d);
  res.on('end', () => {
    try {
      const protos = JSON.parse(body);
      console.log('Total protocol entries:', protos.length);
      
      for (const p of protos) {
        const pid = (p.protocol?.id || '').toLowerCase();
        const pname = (p.protocol?.name || '').toLowerCase();
        if (pid.includes('morpho') || pname.includes('morpho') || pid.includes('sentora')) {
          console.log('\n=== MORPHO ===');
          console.log('Protocol id:', p.protocol?.id);
          console.log('Protocol name:', p.protocol?.name);
          console.log('Chain:', p.chain);
          console.log('Net USD:', p.net_usd);
          if (p.detail?.supply_list) {
            p.detail.supply_list.forEach(s => {
              console.log('  SUPPLY:', s.token?.symbol, 'addr:', s.token?.id, 'amount:', s.token_amount);
            });
          }
          if (p.detail?.borrow_list) {
            p.detail.borrow_list.forEach(b => {
              console.log('  BORROW:', b.token?.symbol, 'addr:', b.token?.id, 'amount:', b.token_amount);
            });
          }
          if (p.detail?.health_rate != null) console.log('  HF:', p.detail.health_rate);
        }
      }
      
      const found = protos.filter(p => {
        const id = (p.protocol?.id||'').toLowerCase();
        const name = (p.protocol?.name||'').toLowerCase();
        return id.includes('morpho') || name.includes('morpho') || id.includes('sentora');
      });
      if (found.length === 0) {
        console.log('\nNo Morpho found. All protocols:');
        protos.forEach(p => console.log(' ' + (p.protocol?.id||'?').padEnd(25) + (p.protocol?.name||'?') + ' | $' + (p.net_usd||0).toFixed(0)));
      }
    } catch(e) {
      console.error('Parse error: ' + e.message);
      console.log(body.slice(0,500));
    }
  });
});
req.on('error', e => console.error('Request error: ' + e.message));
req.end();