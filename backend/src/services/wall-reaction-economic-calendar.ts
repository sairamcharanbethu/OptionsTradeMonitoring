export type BundledEconomicEvent = {
  id: string;
  name: string;
  source: 'BLS' | 'BEA' | 'Federal Reserve' | 'ISM';
  scheduledAt: string;
};

// Verified against the official 2026 BLS, BEA, Federal Reserve, and ISM
// release schedules on 2026-08-03. Wall Reaction fails closed after the
// coverage date until this list is reviewed and extended.
export const WALL_REACTION_CALENDAR_COVERAGE = {
  reviewedAt: '2026-08-03T00:00:00.000Z',
  startsOn: '2026-08-03',
  endsOn: '2026-12-31'
} as const;

export const WALL_REACTION_BUNDLED_EVENTS: BundledEconomicEvent[] = [
  { id: 'ism-manufacturing-2026-08-03', name: 'ISM Manufacturing PMI', source: 'ISM', scheduledAt: '2026-08-03T14:00:00.000Z' },
  { id: 'ism-services-2026-08-05', name: 'ISM Services PMI', source: 'ISM', scheduledAt: '2026-08-05T14:00:00.000Z' },
  { id: 'bls-employment-2026-08-07', name: 'Employment Situation (NFP)', source: 'BLS', scheduledAt: '2026-08-07T12:30:00.000Z' },
  { id: 'bls-cpi-2026-08-12', name: 'Consumer Price Index', source: 'BLS', scheduledAt: '2026-08-12T12:30:00.000Z' },
  { id: 'bls-ppi-2026-08-13', name: 'Producer Price Index', source: 'BLS', scheduledAt: '2026-08-13T12:30:00.000Z' },
  { id: 'bea-pio-2026-08-26', name: 'Personal Income and Outlays (PCE)', source: 'BEA', scheduledAt: '2026-08-26T12:30:00.000Z' },
  { id: 'ism-manufacturing-2026-09-01', name: 'ISM Manufacturing PMI', source: 'ISM', scheduledAt: '2026-09-01T14:00:00.000Z' },
  { id: 'ism-services-2026-09-03', name: 'ISM Services PMI', source: 'ISM', scheduledAt: '2026-09-03T14:00:00.000Z' },
  { id: 'bls-employment-2026-09-04', name: 'Employment Situation (NFP)', source: 'BLS', scheduledAt: '2026-09-04T12:30:00.000Z' },
  { id: 'bls-ppi-2026-09-10', name: 'Producer Price Index', source: 'BLS', scheduledAt: '2026-09-10T12:30:00.000Z' },
  { id: 'bls-cpi-2026-09-11', name: 'Consumer Price Index', source: 'BLS', scheduledAt: '2026-09-11T12:30:00.000Z' },
  { id: 'fed-decision-2026-09-16', name: 'FOMC Rate Decision', source: 'Federal Reserve', scheduledAt: '2026-09-16T18:00:00.000Z' },
  { id: 'fed-press-conference-2026-09-16', name: 'FOMC Press Conference', source: 'Federal Reserve', scheduledAt: '2026-09-16T18:30:00.000Z' },
  { id: 'bea-pio-2026-09-30', name: 'Personal Income and Outlays (PCE)', source: 'BEA', scheduledAt: '2026-09-30T12:30:00.000Z' },
  { id: 'ism-manufacturing-2026-10-01', name: 'ISM Manufacturing PMI', source: 'ISM', scheduledAt: '2026-10-01T14:00:00.000Z' },
  { id: 'bls-employment-2026-10-02', name: 'Employment Situation (NFP)', source: 'BLS', scheduledAt: '2026-10-02T12:30:00.000Z' },
  { id: 'ism-services-2026-10-05', name: 'ISM Services PMI', source: 'ISM', scheduledAt: '2026-10-05T14:00:00.000Z' },
  { id: 'bls-cpi-2026-10-14', name: 'Consumer Price Index', source: 'BLS', scheduledAt: '2026-10-14T12:30:00.000Z' },
  { id: 'bls-ppi-2026-10-15', name: 'Producer Price Index', source: 'BLS', scheduledAt: '2026-10-15T12:30:00.000Z' },
  { id: 'fed-decision-2026-10-28', name: 'FOMC Rate Decision', source: 'Federal Reserve', scheduledAt: '2026-10-28T18:00:00.000Z' },
  { id: 'fed-press-conference-2026-10-28', name: 'FOMC Press Conference', source: 'Federal Reserve', scheduledAt: '2026-10-28T18:30:00.000Z' },
  { id: 'bea-gdp-advance-2026-10-29', name: 'GDP Advance Estimate', source: 'BEA', scheduledAt: '2026-10-29T12:30:00.000Z' },
  { id: 'bea-pio-2026-10-29', name: 'Personal Income and Outlays (PCE)', source: 'BEA', scheduledAt: '2026-10-29T12:30:00.000Z' },
  { id: 'ism-manufacturing-2026-11-02', name: 'ISM Manufacturing PMI', source: 'ISM', scheduledAt: '2026-11-02T15:00:00.000Z' },
  { id: 'ism-services-2026-11-04', name: 'ISM Services PMI', source: 'ISM', scheduledAt: '2026-11-04T15:00:00.000Z' },
  { id: 'bls-employment-2026-11-06', name: 'Employment Situation (NFP)', source: 'BLS', scheduledAt: '2026-11-06T13:30:00.000Z' },
  { id: 'bls-cpi-2026-11-10', name: 'Consumer Price Index', source: 'BLS', scheduledAt: '2026-11-10T13:30:00.000Z' },
  { id: 'bls-ppi-2026-11-13', name: 'Producer Price Index', source: 'BLS', scheduledAt: '2026-11-13T13:30:00.000Z' },
  { id: 'bea-pio-2026-11-25', name: 'Personal Income and Outlays (PCE)', source: 'BEA', scheduledAt: '2026-11-25T13:30:00.000Z' },
  { id: 'ism-manufacturing-2026-12-01', name: 'ISM Manufacturing PMI', source: 'ISM', scheduledAt: '2026-12-01T15:00:00.000Z' },
  { id: 'ism-services-2026-12-03', name: 'ISM Services PMI', source: 'ISM', scheduledAt: '2026-12-03T15:00:00.000Z' },
  { id: 'bls-employment-2026-12-04', name: 'Employment Situation (NFP)', source: 'BLS', scheduledAt: '2026-12-04T13:30:00.000Z' },
  { id: 'fed-decision-2026-12-09', name: 'FOMC Rate Decision', source: 'Federal Reserve', scheduledAt: '2026-12-09T19:00:00.000Z' },
  { id: 'fed-press-conference-2026-12-09', name: 'FOMC Press Conference', source: 'Federal Reserve', scheduledAt: '2026-12-09T19:30:00.000Z' },
  { id: 'bls-cpi-2026-12-10', name: 'Consumer Price Index', source: 'BLS', scheduledAt: '2026-12-10T13:30:00.000Z' },
  { id: 'bls-ppi-2026-12-15', name: 'Producer Price Index', source: 'BLS', scheduledAt: '2026-12-15T13:30:00.000Z' },
  { id: 'bea-pio-2026-12-23', name: 'Personal Income and Outlays (PCE)', source: 'BEA', scheduledAt: '2026-12-23T13:30:00.000Z' }
];
