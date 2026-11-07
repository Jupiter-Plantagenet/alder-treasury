import {test} from 'node:test';import assert from 'node:assert/strict';
import {parseUnitsExact,formatUnitsExact} from '../packages/units.ts';
test('TR-T-UNITS exact > float precision, positive decimal strings only',()=>{assert.equal(parseUnitsExact('9007199254.740993'),9007199254740993n);assert.equal(formatUnitsExact(9007199254740993n),'9007199254.740993');for(const v of ['0','-1','1e6','1,000','1.0000001','NaN',' 1','01'])assert.throws(()=>parseUnitsExact(v));assert.throws(()=>parseUnitsExact((2n**256n).toString()));});
