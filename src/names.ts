// Cleans a contact name before it is shown to anyone else as caller ID. Names are stored as
// the uploader typed them; this runs on every lookup, so rule changes apply to all data at once.

// A word that says how the uploader knows the person, not who they are: the whole name is hidden.
const PRIVATE = new Set(
  `me myself my mine wife wifey husband hubby mom mommy mum mummy mama mother dad daddy father papa
   abbu abba abo abbo ammi ami amma ammy ammu nana nani dada dadi beta beti son daughter sister brother
   sis bro jaan jani love baby babe sweetheart darling sasur susar saas khala khalu phuppo phupho phuphi
   chachu chacha chachi mamu mamoon mamun mami taya tayi bhabhi bhabi behan bahan unknown spam scam fraud
   private dont don't امی ابو بیوی شوہر جان بہن بھابھی`.split(/\s+/),
);

// Honorifics and tags (network, place, "new"): dropped, the rest of the name stays.
const TAGS = new Set(
  `bhai bhaijan bhaiya baji apa appi aapi sb sab sahab sahib saab ji jee sir madam maam new old jazz ufone
   zong telenor warid onic mobilink office home work whatsapp wa wapp pk uae ksa num number no cell
   mobile landline ptcl بھائی باجی صاحب جی`.split(/\s+/),
);

const CAMEL_TAG = /(\p{Ll})(New|Old|Jazz|Ufone|Zong|Telenor|Office|Home|Work)$/u;
const key = (w: string) => w.toLowerCase().replace(/\.+$/, '');
const mixedScript = (w: string) => /\p{Script=Latin}/u.test(w) && /\p{Script=Arabic}/u.test(w);

/** The name to show others, or null when it isn't a name worth sharing. */
export function cleanName(raw: string): string | null {
  const words = raw
    .replace(/[^\p{L}\p{M}\s.'-]/gu, ' ') // digits, emoji, symbols
    .split(/\s+/)
    .flatMap((w) => w.replace(CAMEL_TAG, '$1 $2').split(' '))
    .map((w) => w.replace(/^[.'-]+|[-']+$/g, ''))
    .filter(Boolean);
  // Latin and Urdu letters mixed in one name is keyboard junk ("ع@l$i@RaZ").
  if (mixedScript(raw) || words.some((w) => PRIVATE.has(key(w)))) return null;
  const kept = words.filter((w) => !TAGS.has(key(w)));
  // "Ali U", "Kamran M.": a trailing initial is the uploader's own note.
  while (kept.length > 1 && key(kept[kept.length - 1]).length === 1) kept.pop();
  if (!kept.some((w) => key(w).length > 1)) return null;
  return kept.map((w) => (w === w.toLowerCase() ? w.charAt(0).toUpperCase() + w.slice(1) : w)).join(' ');
}

// Common names and surnames in their usual English spelling. Urdu script drops short vowels,
// so a dictionary beats letter rules; letters are the fallback for anything not listed here.
// ponytail: hand-made list, grow it from names that come out wrong.
const URDU_NAMES: Record<string, string> = Object.fromEntries(
  `محمد Muhammad|احمد Ahmed|علی Ali|عمر Umar|عثمان Usman|اسامہ Usama|حسن Hassan|حسین Hussain|حسنین Hasnain
  |عباس Abbas|عبد Abdul|اللہ Allah|رحمان Rehman|رحمن Rehman|وحید Waheed|وارث Waris|حنان Hannan|منان Mannan
  |سجاد Sajjad|مریم Maryam|فاطمہ Fatima|عائشہ Ayesha|زینب Zainab|خدیجہ Khadija|آمنہ Amna|اسماء Asma|اسما Asma
  |ثنا Sana|سارہ Sara|حنا Hina|نادیہ Nadia|صائمہ Saima|رابعہ Rabia|سعدیہ Sadia|شازیہ Shazia|نازیہ Nazia
  |کرن Kiran|ماریہ Maria|ام Ume|حبیبہ Habiba|بلال Bilal|زبیر Zubair|زاہد Zahid|ساجد Sajid|ماجد Majid
  |خالد Khalid|طارق Tariq|عارف Arif|آصف Asif|کاشف Kashif|عاطف Atif|راشد Rashid|رشید Rasheed|حامد Hamid
  |شاہد Shahid|جاوید Javed|نوید Naveed|سعید Saeed|مجید Majeed|حمید Hameed|فرید Fareed|رضا Raza|رضوان Rizwan
  |عمران Imran|عرفان Irfan|کامران Kamran|سلمان Salman|سلیمان Sulaiman|فیصل Faisal|فہد Fahad|حمزہ Hamza
  |حذیفہ Huzaifa|یوسف Yousaf|یونس Younas|ادریس Idrees|ابراہیم Ibrahim|اسماعیل Ismail|اسحاق Ishaq|یعقوب Yaqoob
  |ایوب Ayoub|موسی Musa|عیسی Isa|داؤد Dawood|داود Dawood|سلیم Saleem|نسیم Naseem|وسیم Waseem|ندیم Nadeem
  |کریم Kareem|رحیم Raheem|حکیم Hakeem|عظیم Azeem|نعیم Naeem|شمیم Shamim|اکرم Akram|اسلم Aslam|اعظم Azam
  |اشرف Ashraf|اکبر Akbar|اصغر Asghar|جعفر Jafar|حیدر Haider|قاسم Qasim|ہاشم Hashim|عاصم Asim|نعمان Noman
  |ذیشان Zeeshan|شان Shan|دانش Danish|دانیال Daniyal|ثاقب Saqib|واصف Wasif|وسی Wasi|واسع Wasi|مقصود Maqsood
  |محمود Mahmood|مسعود Masood|منصور Mansoor|منظور Manzoor|نذیر Nazir|بشیر Bashir|شبیر Shabbir|قدیر Qadeer
  |نصیر Naseer|تنویر Tanveer|توقیر Touqeer|زوہیب Zohaib|زہیب Zohaib|شعیب Shoaib|صہیب Suhaib|ابو Abu|بکر Bakar
  |بن Bin|ظفر Zafar|اظہر Azhar|مظہر Mazhar|انور Anwar|نور Noor|عطا Atta|رحمت Rehmat|برکت Barkat|نعمت Naimat
  |غلام Ghulam|مصطفی Mustafa|مرتضی Murtaza|مجتبی Mujtaba|رسول Rasool|نبی Nabi|بخش Bakhsh|دین Din|خان Khan
  |ملک Malik|چوہدری Chaudhry|چودھری Chaudhry|شیخ Sheikh|سید Syed|شاہ Shah|قریشی Qureshi|بلوچ Baloch|سومرو Soomro
  |ابڑو Abro|سیال Siyal|مغل Mughal|مہر Mehar|میمن Memon|جتوئی Jatoi|بھٹو Bhutto|پٹھان Pathan|راجپوت Rajput
  |جٹ Jatt|اعوان Awan|عباسی Abbasi|صدیقی Siddiqui|فاروقی Farooqui|فاروق Farooq|انصاری Ansari|ہاشمی Hashmi
  |جمیل Jameel|شکیل Shakeel|عقیل Aqeel|نبیل Nabeel|خلیل Khalil|جلیل Jaleel|اقبال Iqbal|جمال Jamal|کمال Kamal
  |شاہین Shaheen|یاسمین Yasmeen|پروین Parveen|نسرین Nasreen|رخسانہ Rukhsana|فرزانہ Farzana|شبانہ Shabana
  |ریحانہ Rehana|عذرا Azra|صغری Sughra|کلثوم Kulsoom|جنت Jannat|ایاز Ayaz|نواز Nawaz|شہباز Shahbaz|فراز Faraz
  |ممتاز Mumtaz|اعجاز Ejaz|امتیاز Imtiaz|ریاض Riaz|فیاض Fayyaz|مولانا Molana|مولوی Molvi|حافظ Hafiz
  |ڈاکٹر Dr|حاجی Haji|ہبہ Hiba|عالیہ Aliya|علیزہ Aliza|ایمن Aiman|انعم Anum|مہوش Mehwish|ثمینہ Samina
  |قادر Qadir|عبدالقادر Abdul Qadir|پرویز Parvez|شہزاد Shahzad|شہزادہ Shahzada|فرحان Farhan|عدنان Adnan
  |ارسلان Arsalan|شاہزیب Shahzaib|جہانزیب Jahanzaib|اویس Awais|انس Anas|طلحہ Talha|سعد Saad|اسد Asad
  |گوہر Gohar|سرور Sarwar|کوثر Kausar|شہریار Shehryar|مہتاب Mehtab|شہناز Shehnaz|شہلا Shehla|زہرہ Zahra`
    .split('|')
    .map((e) => { const t = e.trim(); const i = t.indexOf(' '); return [t.slice(0, i), t.slice(i + 1)]; }),
);

const LETTERS: Record<string, string> = {
  ب: 'b', پ: 'p', ت: 't', ٹ: 't', ث: 's', ج: 'j', چ: 'ch', ح: 'h', خ: 'kh', د: 'd', ڈ: 'd', ذ: 'z',
  ر: 'r', ڑ: 'r', ز: 'z', ژ: 'zh', س: 's', ش: 'sh', ص: 's', ض: 'z', ط: 't', ظ: 'z', غ: 'gh', ف: 'f',
  ق: 'q', ک: 'k', گ: 'g', ل: 'l', م: 'm', ن: 'n', ں: 'n',
};

/** Letter-by-letter guess: consonants as written, an "a" between two of them. */
function spell(word: string): string {
  let out = '';
  let lastConsonant = false;
  [...word].forEach((ch, i, all) => {
    const first = i === 0;
    const last = i === all.length - 1;
    let s: string;
    let vowel = true;
    if (ch === 'ا' || ch === 'آ') s = 'a';
    else if (ch === 'ع') s = first ? 'a' : '';
    else if (ch === 'و') {
      // "w" before a vowel letter (پرویز Parvez), else a long "o" (محمود Mahmood).
      const w = first || 'اآیے'.includes(all[i + 1] ?? '');
      (s = w ? (first ? 'w' : 'v') : 'o'), (vowel = !w);
    }
    else if (ch === 'ی') (s = first ? 'y' : last ? 'i' : 'ee'), (vowel = !first);
    else if (ch === 'ے') s = 'e';
    else if (ch === 'ہ') (s = last ? 'a' : 'h'), (vowel = last);
    else if (ch === 'ھ') (s = 'h'), (vowel = false), (lastConsonant = false);
    else if (LETTERS[ch]) (s = LETTERS[ch]), (vowel = false);
    else s = '';
    if (!s) return;
    if (!vowel && lastConsonant) out += 'a';
    out += s;
    lastConsonant = !vowel;
  });
  return out.charAt(0).toUpperCase() + out.slice(1);
}

const romanWord = (w: string): string => {
  if (URDU_NAMES[w]) return URDU_NAMES[w];
  if (w.startsWith('عبدال') && w.length > 5) return `Abdul ${romanWord(w.slice(5))}`; // عبدالرحمن
  if (w.startsWith('ال') && w.length > 3) return romanWord(w.slice(2)); // الوارث after عبد
  if (w.endsWith('اللہ') && w.length > 4) return `${romanWord(w.slice(0, -4))}ullah`; // نوراللہ
  return spell(w);
};

/** An Urdu-script name in English letters ("عبد الوارث" -> "Abdul Waris"). Others pass through. */
export function romanize(name: string): string {
  if (!/\p{Script=Arabic}/u.test(name)) return name;
  const norm = name
    .replace(/ك/g, 'ک').replace(/[يى]/g, 'ی').replace(/[هة]/g, 'ہ').replace(/ۃ/g, 'ہ').replace(/ئ$/, 'ی')
    .replace(/[ً-ٰٟـ]/g, ''); // vowel marks, tatweel
  return norm.split(/\s+/).filter(Boolean).map(romanWord).filter(Boolean).join(' ');
}
