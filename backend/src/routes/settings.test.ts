import { isGlobalSettingKey, isPublicGlobalSettingKey, validateEntryLastMinuteSetting, validateEntryOpenBufferMinutesSetting, validateEventBlackoutDatesSetting, validateMarketPollIntervalSetting, validateSyntheticTrailingStopPctSetting, validateTakeProfitPctSetting } from '../lib/settings-utils';

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
  assert(validateSyntheticTrailingStopPctSetting('1') === null, '1% synthetic trail should be accepted');
  assert(validateSyntheticTrailingStopPctSetting('15') === null, '15% synthetic trail should be accepted');
  assert(validateSyntheticTrailingStopPctSetting('50') === null, '50% synthetic trail should be accepted');
  assert(Boolean(validateSyntheticTrailingStopPctSetting('0')), 'A zero synthetic trail should be rejected');
  assert(Boolean(validateSyntheticTrailingStopPctSetting('50.1')), 'Synthetic trails above 50% should be rejected');
  assert(Boolean(validateSyntheticTrailingStopPctSetting('')), 'A synthetic trail percentage is required');
  assert(isGlobalSettingKey('market_poll_interval'), 'The shared market poll interval must be a global setting');
  assert(isGlobalSettingKey('polling_enabled'), 'The shared market polling toggle must be a global setting');
  assert(isPublicGlobalSettingKey('polling_enabled'), 'Users should be able to see the admin-controlled polling state');
  assert(validateMarketPollIntervalSetting('1') === null, 'A one-second explicit interval should be accepted');
  assert(validateMarketPollIntervalSetting('900') === null, 'The 15-minute interval boundary should be accepted');
  assert(Boolean(validateMarketPollIntervalSetting('0')), 'A zero-second interval should be rejected');
  assert(Boolean(validateMarketPollIntervalSetting('1.5')), 'Fractional poll intervals should be rejected');
  assert(Boolean(validateMarketPollIntervalSetting('901')), 'Intervals above 15 minutes should be rejected');
  assert(isGlobalSettingKey('entry_last_minute_et') && isPublicGlobalSettingKey('entry_last_minute_et'), 'The entry cutoff is a visible global setting');
  assert(validateEntryOpenBufferMinutesSetting('0') === null && validateEntryOpenBufferMinutesSetting('15') === null && validateEntryOpenBufferMinutesSetting('120') === null, 'Open buffer accepts 0-120 minutes');
  assert(Boolean(validateEntryOpenBufferMinutesSetting('121')) && Boolean(validateEntryOpenBufferMinutesSetting('-1')) && Boolean(validateEntryOpenBufferMinutesSetting('x')), 'Open buffer rejects out-of-range or non-integer values');
  assert(validateEntryLastMinuteSetting('11:00') === null && validateEntryLastMinuteSetting('15:00') === null, 'Entry last minute accepts session times');
  assert(Boolean(validateEntryLastMinuteSetting('09:30')) && Boolean(validateEntryLastMinuteSetting('15:01')) && Boolean(validateEntryLastMinuteSetting('noon')), 'Entry last minute rejects the open, post-15:00 and garbage');
  assert(validateEventBlackoutDatesSetting('') === null && validateEventBlackoutDatesSetting('[{"date":"2027-01-27","label":"FOMC"}]') === null, 'Custom event blackouts accept blank and valid JSON');
  assert(Boolean(validateEventBlackoutDatesSetting('[{"date":"Jan 27"}]')), 'Custom event blackouts reject malformed dates');
  console.log('All settings validation tests passed!');
}

runTests().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
