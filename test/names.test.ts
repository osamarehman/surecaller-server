import { describe, expect, it } from 'vitest';
import { cleanName, romanize } from '../src/names.js';

describe('cleanName', () => {
  it('hides names that only say how the uploader knows the person', () => {
    for (const n of ['Me', 'Ami', 'Abo', '1st Wife', '2nd Wife', 'Ali Ka Husband',
      '+923001234567', 'A W T', 'Bhai', 'ع@l$i@RaZ', 'Ali ki Ammi', 'امی'])
      expect(cleanName(n), n).toBeNull();
  });
  it('trims tags, honorifics, digits and trailing initials', () => {
    const cases: [string, string][] = [
      ['Omar Jazz', 'Omar'], ['Raza Ufone', 'Raza'], ['Omar1', 'Omar'], ['Ali Bhai', 'Ali'],
      ['Bilal Z', 'Bilal'], ['Kamran M.', 'Kamran'], ['SanaNew', 'Sana'], ['A rauf M2', 'A Rauf'],
      ['Molvi Hamid Sb', 'Molvi Hamid'], ['sara malik', 'Sara Malik'], ['G.Mustafa', 'G.Mustafa'],
      ['MN Khan', 'MN Khan'], ['Abu Z.', 'Abu'], ['عبد الوارث', 'عبد الوارث'], ['Ali 😀 Raza', 'Ali Raza'],
    ];
    for (const [raw, want] of cases) expect(cleanName(raw), raw).toBe(want);
  });
});

describe('romanize', () => {
  it('writes Urdu names in English letters', () => {
    const cases: [string, string][] = [
      ['عبد الوارث', 'Abdul Waris'], ['وحید', 'Waheed'], ['محمد علی', 'Muhammad Ali'], ['عبدالرحمن', 'Abdul Rehman'],
      ['نوراللہ', 'Noorullah'], ['مريم ملک', 'Maryam Malik'], ['خان', 'Khan'], ['Ali Raza', 'Ali Raza'],
    ];
    for (const [raw, want] of cases) expect(romanize(raw), raw).toBe(want);
    expect(romanize('بھٹو')).toBe('Bhutto');
    expect(romanize('بشارت')).toMatch(/^B/); // not listed: letter guess
  });
});
