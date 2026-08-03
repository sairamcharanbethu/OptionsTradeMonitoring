import { isGlobalSettingKey, isPublicGlobalSettingKey, validateMarketPollIntervalSetting, validateTakeProfitPctSetting } from '../lib/settings-utils';

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

async function runTests() {
  console.log('Running settings validation tests...');
  assert(validateTakeProfitPctSetting('') === null, 'Blank should disable the premium override');
  assert(validateTakeProfitPctSetting('10') === null, '10% should be accepted');
  assert(validateTakeProfitPctSetting('500') === null, '500% boundary should be accepted');
  assert(Boolean(validateTakeProfitPctSetting('0')), '0% should be rejected');
  assert(Boolean(validateTakeProfitPctSetting('-10')), 'Negative percentages should be rejected');
  assert(Boolean(validateTakeProfitPctSetting('501')), 'Values above 500% should be rejected');
  assert(Boolean(validateTakeProfitPctSetting('not-a-number')), 'Non-numeric values should be rejected');
  assert(isGlobalSettingKey('market_poll_interval'), 'The shared market poll interval must be a global setting');
  assert(isGlobalSettingKey('polling_enabled'), 'The shared market polling toggle must be a global setting');
  assert(isPublicGlobalSettingKey('polling_enabled'), 'Users should be able to see the admin-controlled polling state');
  assert(validateMarketPollIntervalSetting('1') === null, 'A one-second explicit interval should be accepted');
  assert(validateMarketPollIntervalSetting('900') === null, 'The 15-minute interval boundary should be accepted');
  assert(Boolean(validateMarketPollIntervalSetting('0')), 'A zero-second interval should be rejected');
  assert(Boolean(validateMarketPollIntervalSetting('1.5')), 'Fractional poll intervals should be rejected');
  assert(Boolean(validateMarketPollIntervalSetting('901')), 'Intervals above 15 minutes should be rejected');
  console.log('All settings validation tests passed!');
}

runTests().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
