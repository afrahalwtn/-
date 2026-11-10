import assert from 'node:assert/strict';
import {parseLocalizedNumber} from '../web/numeric-input.js';

const passing=[
  ['١٢٬٥٠٠',12500,{}],
  ['١٢٫٧٥',12.75,{}],
  ['۱۲۳۴',1234,{integer:true}],
  ['٢٥',25,{integer:true,min:1,max:100000000}],
  ['1,250.50',1250.5,{}],
  ['1,5',1.5,{}],
  ['0',0,{integer:true}],
  ['',null,{optional:true}],
  [' ٣٥ ',35,{integer:true}],
];
for(const [raw,expected,options] of passing){
  assert.equal(parseLocalizedNumber(raw,options),expected,'Valid numeric input: '+raw);
}
const blocked=[
  ['abc',{}],['-4',{}],['1e6',{}],['5.5',{integer:true}],
  ['',{}],['١٢دولار',{}],['999999999',{integer:true,max:100000000}],
  ['7.333.2',{}],
];
for(const [raw,options] of blocked){
  assert.throws(()=>parseLocalizedNumber(raw,options),Error,'Invalid numeric input: '+raw);
}
console.log('PASS: 17 localized numeric input regression cases');
