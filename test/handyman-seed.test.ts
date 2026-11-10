import { describe, expect, it } from 'vitest';
import { classifyTrade } from '../src/routes/handymen.js';

describe('classifyTrade', () => {
  it.each([
    ['Ali Plumber', 'Plumber', 'Ali'],
    ['Asif Electrician', 'Electrician', 'Asif'],
    ['Bilal AC wala', 'AC Technician', 'Bilal'],
    ['Carpenter Rashid', 'Carpenter', 'Rashid'],
    ['Akram bijli wala', 'Electrician', 'Akram'],
    ['Raj Mistri Sadiq', 'Mason', 'Sadiq'],
    ['Nadeem AC Mechanic', 'AC Technician', 'Nadeem'],
    ['Kashif mistri', 'Mechanic', 'Kashif'],
    ['Tarkhan (Gulzar)', 'Carpenter', 'Gulzar'],
    ['Plumber', 'Plumber', 'Plumber'],
    ['اکرم پلمبر', 'Plumber', 'اکرم'],
    ['Shamim maid', 'Cleaner', 'Shamim'],
  ])('%s -> %s', (input, category, name) => {
    expect(classifyTrade(input)).toMatchObject({ category, name });
  });

  it.each(['Acer Office', 'Zaheer Abbas', 'Rajesh', 'Painterly Studio', 'Shafqat Sweet Home', 'Masi Rubina'])('%s is no trade', (n) => {
    expect(classifyTrade(n)).toBeNull();
  });
});
