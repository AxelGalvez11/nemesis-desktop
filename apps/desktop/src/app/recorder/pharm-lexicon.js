// Deterministic pharm-vocabulary correction for Whisper transcripts. The tiny ASR model
// nails sentence structure but garbles drug names ("Lycinepral", "Low-Sartan", "Brady
// Kinden"). Instead of a bigger model (4× slower) or an LLM pass (cloud + cost), we
// fuzzy-match tokens — and adjacent token PAIRS, for split-up names — against a canonical
// pharmacy lexicon with a length-scaled edit-distance budget. Pure functions, unit-smokeable.
const LEXICON_RAW = [
    // cardio / renal
    'lisinopril', 'enalapril', 'ramipril', 'captopril', 'losartan', 'valsartan', 'candesartan', 'irbesartan',
    'amlodipine', 'nifedipine', 'diltiazem', 'verapamil', 'metoprolol', 'atenolol', 'propranolol', 'carvedilol',
    'bisoprolol', 'labetalol', 'furosemide', 'bumetanide', 'torsemide', 'hydrochlorothiazide', 'chlorthalidone',
    'spironolactone', 'eplerenone', 'atorvastatin', 'rosuvastatin', 'simvastatin', 'pravastatin', 'ezetimibe',
    'warfarin', 'apixaban', 'rivaroxaban', 'dabigatran', 'edoxaban', 'heparin', 'enoxaparin', 'clopidogrel',
    'ticagrelor', 'prasugrel', 'aspirin', 'digoxin', 'amiodarone', 'sotalol', 'sacubitril', 'hydralazine',
    'isosorbide', 'nitroglycerin', 'dobutamine', 'dopamine', 'norepinephrine', 'epinephrine', 'adenosine',
    // endocrine / diabetes
    'metformin', 'insulin', 'glipizide', 'glyburide', 'glimepiride', 'sitagliptin', 'linagliptin',
    'empagliflozin', 'dapagliflozin', 'canagliflozin', 'semaglutide', 'liraglutide', 'dulaglutide', 'exenatide',
    'pioglitazone', 'levothyroxine', 'methimazole', 'propylthiouracil', 'prednisone', 'prednisolone',
    'dexamethasone', 'hydrocortisone', 'fludrocortisone', 'desmopressin',
    // infectious disease
    'amoxicillin', 'ampicillin', 'penicillin', 'piperacillin', 'tazobactam', 'cephalexin', 'cefazolin',
    'ceftriaxone', 'cefepime', 'ceftazidime', 'meropenem', 'ertapenem', 'aztreonam', 'vancomycin', 'linezolid',
    'daptomycin', 'azithromycin', 'clarithromycin', 'erythromycin', 'doxycycline', 'minocycline', 'tetracycline',
    'ciprofloxacin', 'levofloxacin', 'moxifloxacin', 'metronidazole', 'clindamycin', 'trimethoprim',
    'sulfamethoxazole', 'nitrofurantoin', 'fosfomycin', 'gentamicin', 'tobramycin', 'amikacin', 'fluconazole',
    'voriconazole', 'itraconazole', 'amphotericin', 'nystatin', 'caspofungin', 'acyclovir', 'valacyclovir',
    'oseltamivir', 'remdesivir', 'rifampin', 'isoniazid', 'pyrazinamide', 'ethambutol', 'dapsone',
    // neuro / psych
    'gabapentin', 'pregabalin', 'phenytoin', 'fosphenytoin', 'carbamazepine', 'oxcarbazepine', 'lamotrigine',
    'levetiracetam', 'valproate', 'topiramate', 'zonisamide', 'sertraline', 'fluoxetine', 'paroxetine',
    'citalopram', 'escitalopram', 'venlafaxine', 'desvenlafaxine', 'duloxetine', 'bupropion', 'mirtazapine',
    'trazodone', 'amitriptyline', 'nortriptyline', 'lithium', 'quetiapine', 'risperidone', 'paliperidone',
    'olanzapine', 'aripiprazole', 'haloperidol', 'clozapine', 'ziprasidone', 'lurasidone', 'buspirone',
    'lorazepam', 'diazepam', 'alprazolam', 'clonazepam', 'midazolam', 'temazepam', 'zolpidem', 'suvorexant',
    'sumatriptan', 'rizatriptan', 'levodopa', 'carbidopa', 'pramipexole', 'ropinirole', 'donepezil',
    'rivastigmine', 'memantine', 'methylphenidate', 'amphetamine', 'atomoxetine',
    // GI
    'omeprazole', 'pantoprazole', 'esomeprazole', 'lansoprazole', 'famotidine', 'ondansetron',
    'metoclopramide', 'prochlorperazine', 'sucralfate', 'misoprostol', 'mesalamine', 'loperamide',
    'docusate', 'lactulose', 'linaclotide', 'rifaximin',
    // pain / rheum / heme-onc
    'ibuprofen', 'naproxen', 'ketorolac', 'celecoxib', 'meloxicam', 'diclofenac', 'indomethacin',
    'acetaminophen', 'morphine', 'oxycodone', 'hydrocodone', 'hydromorphone', 'fentanyl', 'tramadol',
    'methadone', 'naloxone', 'naltrexone', 'buprenorphine', 'lidocaine', 'ketamine', 'colchicine',
    'allopurinol', 'febuxostat', 'probenecid', 'methotrexate', 'hydroxychloroquine', 'sulfasalazine',
    'leflunomide', 'adalimumab', 'etanercept', 'infliximab', 'rituximab', 'tocilizumab', 'cisplatin',
    'carboplatin', 'paclitaxel', 'docetaxel', 'doxorubicin', 'cyclophosphamide', 'vincristine', 'tamoxifen',
    'anastrozole', 'letrozole', 'trastuzumab', 'pembrolizumab', 'nivolumab', 'imatinib', 'filgrastim',
    'epoetin', 'tacrolimus', 'cyclosporine', 'mycophenolate', 'azathioprine', 'sirolimus', 'basiliximab',
    // resp / allergy / uro / bone
    'albuterol', 'levalbuterol', 'ipratropium', 'tiotropium', 'fluticasone', 'budesonide', 'mometasone',
    'montelukast', 'salmeterol', 'formoterol', 'theophylline', 'diphenhydramine', 'loratadine', 'cetirizine',
    'fexofenadine', 'hydroxyzine', 'tamsulosin', 'finasteride', 'dutasteride', 'sildenafil', 'tadalafil',
    'oxybutynin', 'mirabegron', 'tolterodine', 'alendronate', 'risedronate', 'zoledronic', 'denosumab',
    'raloxifene', 'teriparatide', 'calcitonin',
    // core pharm/physiology vocabulary the tiny model also garbles
    'bradykinin', 'angioedema', 'angiotensin', 'aldosterone', 'renin', 'hyperkalemia', 'hypokalemia',
    'hyponatremia', 'hypernatremia', 'hypercalcemia', 'hypocalcemia', 'hypomagnesemia', 'nephrotoxicity',
    'ototoxicity', 'hepatotoxicity', 'rhabdomyolysis', 'myopathy', 'agranulocytosis', 'thrombocytopenia',
    'neutropenia', 'pancytopenia', 'anaphylaxis', 'creatinine', 'tachycardia', 'bradycardia', 'hypotension',
    'hypertension', 'torsades', 'serotonin', 'tyramine', 'cytochrome', 'prodrug', 'bioavailability',
    'pharmacokinetics', 'pharmacodynamics', 'teratogenic', 'contraindicated', 'gynecomastia', 'photosensitivity'
];
const LEXICON = [...new Set(LEXICON_RAW)];
/** Consonant skeleton: ASR garbles vowels far more than consonants ("lycinepral" vs
 *  "lisinopril" differ by 4 edits but share the exact skeleton LSNPRL). c→s before e/i/y,
 *  ph→f, remaining c→k, drop vowels, collapse doubles. */
function skeleton(word) {
    return word
        .replace(/c(?=[eiy])/g, 's')
        .replace(/ph/g, 'f')
        .replace(/c/g, 'k')
        .replace(/[aeiou]/g, '')
        .replace(/(.)\1+/g, '$1');
}
const LEXICON_SKELETONS = LEXICON.map(term => ({ skeleton: skeleton(term), term }));
/** Normalize a candidate: lowercase, letters only (drops hyphens/spaces/punctuation). */
function normalize(raw) {
    return raw.toLowerCase().replace(/[^a-z]/g, '');
}
/** Classic Levenshtein, early-abandoned via band cap. */
function editDistance(a, b, cap) {
    if (Math.abs(a.length - b.length) > cap) {
        return cap + 1;
    }
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
        const row = [i];
        let rowMin = i;
        for (let j = 1; j <= b.length; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            const value = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + cost);
            row.push(value);
            if (value < rowMin) {
                rowMin = value;
            }
        }
        if (rowMin > cap) {
            return cap + 1;
        }
        prev = row;
    }
    return prev[b.length];
}
/** Budget scales with word length: short words must be near-exact, long ones get slack. */
function budgetFor(length) {
    return length <= 6 ? 1 : length <= 10 ? 2 : 3;
}
function bestMatch(candidate) {
    if (candidate.length < 5) {
        return null;
    }
    let best = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const term of LEXICON) {
        const cap = budgetFor(Math.max(candidate.length, term.length));
        const distance = editDistance(candidate, term, cap);
        if (distance <= cap && distance < bestDistance) {
            bestDistance = distance;
            best = term;
            if (distance === 0) {
                break;
            }
        }
    }
    if (best) {
        return best;
    }
    // Skeleton fallback for long, heavily vowel-garbled words only (≥8 chars keeps common
    // English words out of reach). Exact-or-1 skeleton match + similar overall length.
    if (candidate.length >= 8) {
        const candidateSkeleton = skeleton(candidate);
        for (const entry of LEXICON_SKELETONS) {
            if (Math.abs(entry.term.length - candidate.length) <= 3 &&
                editDistance(candidateSkeleton, entry.skeleton, 1) <= 1) {
                return entry.term;
            }
        }
    }
    return null;
}
const TOKEN_SPLIT = /(\s+)/;
function matchCase(replacement, original) {
    return /^[A-Z]/.test(original) ? replacement[0].toUpperCase() + replacement.slice(1) : replacement;
}
/** Correct garbled pharm terms in a transcript. Tries adjacent token pairs first (split-up
 *  names like "Brady Kinden"), then single tokens. Whitespace and punctuation preserved. */
export function correctPharmTerms(text) {
    const parts = text.split(TOKEN_SPLIT);
    const changes = [];
    // parts alternate token / whitespace; token indices are even.
    for (let i = 0; i < parts.length; i += 2) {
        const token = parts[i];
        if (!token) {
            continue;
        }
        const trailing = token.match(/[.,;:!?)]*$/)?.[0] ?? '';
        const core = trailing ? token.slice(0, token.length - trailing.length) : token;
        const normalized = normalize(core);
        if (!normalized || LEXICON.includes(normalized)) {
            continue;
        }
        // Pair attempt: this token + the next one as a single split-up term.
        const nextIndex = i + 2;
        const nextToken = parts[nextIndex];
        if (nextToken && core.length >= 3) {
            const nextTrailing = nextToken.match(/[.,;:!?)]*$/)?.[0] ?? '';
            const nextCore = nextTrailing ? nextToken.slice(0, nextToken.length - nextTrailing.length) : nextToken;
            // Both halves must be substantial — otherwise little words ("as", "an") get
            // swallowed into a neighboring drug name.
            const pair = nextCore.length >= 3 ? normalize(core + nextCore) : '';
            const pairMatch = pair.length >= 7 ? bestMatch(pair) : null;
            if (pairMatch) {
                changes.push({ from: `${core} ${nextCore}`, to: pairMatch });
                parts[i] = matchCase(pairMatch, core) + nextTrailing;
                parts[i + 1] = ''; // swallow the joining whitespace
                parts[nextIndex] = '';
                continue;
            }
        }
        const single = bestMatch(normalized);
        if (single) {
            changes.push({ from: core, to: single });
            parts[i] = matchCase(single, core) + trailing;
        }
    }
    return { changes, corrected: parts.join('') };
}
