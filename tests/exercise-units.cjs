const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
for (const script of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) new vm.Script(script[1]);
(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_PATH ? { executablePath: process.env.BROWSER_PATH } : {}) });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: html });
      if (url.pathname === '/api/auth/me') return route.fulfill({ json: { username: 'unit-test' } });
      if (url.pathname === '/api/bootstrap') return route.fulfill({ json: {} });
      if (url.pathname.startsWith('/api/data/')) return route.fulfill({ json: { ok: true } });
      return route.fulfill({ status: 204, body: '' });
    });
    await page.goto('http://workout.test/');
    await page.waitForFunction(() => document.getElementById('appRoot').style.display === 'block');
    const result = await page.evaluate(() => {
      templates = [{ id: 'mixed', name: 'Mixed', exercises: [
        { name: 'Machine', sets: 1, reps: '10' }, { name: 'Barbell', sets: 1, reps: '10' }
      ] }];
      selectedTemplateId = 'mixed';
      saveWeightUnit('kg');
      document.getElementById('sessionDate').value = '2026-09-12';
      renderTodayLog();
      const cards = () => [...document.querySelectorAll('#todayLogWrap .exercise')];
      const weight = i => cards()[i].querySelector('.weight');
      toggleWeightUnitQuick(cards()[0].querySelector('.unit-toggle'));
      weight(0).value = '100'; weight(1).value = '50';
      cards().forEach(c => c.querySelector('.reps').value = '10');
      captureDraftFromDOM();
      const draft = loadDraft('mixed', '2026-09-12');
      const mixedUnits = cards().map(cardWeightUnit);
      for(let i=0; i<20; i++) toggleWeightUnitQuick(cards()[0].querySelector('.unit-toggle'));
      const afterToggles = [weight(0).value, readWeightInput(weight(0)), weight(1).value];
      renderTodayLog(); restoreDraftIntoDOM();
      const restored = cards().map(c => [cardWeightUnit(c), c.querySelector('.weight').value]);
      saveSession();
      const saved = loadSessions().find(s => s.templateId === 'mixed');
      renderTodayLog();
      copyPreviousSets(0); copyPreviousSets(1);
      const repeated = [weight(0).value, weight(1).value];
      // Switch the destination to kg; history must be converted into kg once.
      toggleWeightUnitQuick(cards()[0].querySelector('.unit-toggle'));
      weight(0).value = ''; copyPreviousSets(0);
      const repeatedKg = [weight(0).value, readWeightInput(weight(0))];
      editSessionData = JSON.parse(JSON.stringify(saved)); renderSessionEdit();
      const editor = [...document.querySelectorAll('#sessionEditWrap input[placeholder="lb"], #sessionEditWrap input[placeholder="кг"]')].map(i=>[i.value,i.placeholder]);
      toggleEditWeightUnit(0);
      const editorStored = editSessionData.exercises[0].sets[0].weight;

      templates = [{ id:'favorite', name:'Favorite', fav:true, exercises:[{ name:'Machine', sets:1, reps:'10' }] }];
      editingTemplateId = 'favorite';
      draftExercises = JSON.parse(JSON.stringify(templates[0].exercises));
      document.getElementById('tplNameInput').value = 'Favorite edited';
      saveTemplate();
      const favoritePreserved = templates[0].fav === true;

      window.__xss = 0;
      const injection = `<img src=x onerror="window.__xss=1">`;
      const handlerInjection = `');window.__xss=1;//`;
      saveLibrary([{ id:'unsafe-library', name:'Unsafe exercise', group:injection }]);
      library = loadLibrary();
      saveSessions([{ id:'unsafe-session', date:'2026-09-12', templateName:injection, exercises:[
        { name:'Unsafe exercise', sets:[{ weight:'10', reps:handlerInjection }] }
      ] }]);
      currentExerciseDetail = 'Unsafe exercise';
      renderExerciseDetail();
      const detailHasInjectedElement = !!document.querySelector('#exerciseDetailWrap img');
      const chartPoint = document.querySelector('#exerciseDetailWrap .chart-point');
      if(chartPoint) chartPoint.click();

      safeSetItem(MEASURE_KEY, JSON.stringify({ '2026-09-12': { neck:injection } }));
      measureHistoryExpanded = true;
      renderMeasureHistory();
      const measurementsHaveInjectedElement = !!document.querySelector('#measureHistoryList img');

      safeSetItem(S_KEY, JSON.stringify({ malformed:true }));
      const malformedSessionsLength = loadSessions().length;
      const localDate = dateToLocalISO(new Date(2026, 8, 12, 0, 30));
      return {
        draft, mixedUnits, afterToggles, restored, saved, repeated, repeatedKg, editor, editorStored,
        favoritePreserved, detailHasInjectedElement, measurementsHaveInjectedElement,
        xssExecuted: window.__xss, malformedSessionsLength, localDate
      };
    });
    assert.deepEqual(result.mixedUnits, ['lb','kg']);
    assert.equal(result.draft.exercises[0].sets[0].weight, '45.359237');
    assert.equal(result.draft.exercises[1].sets[0].weight, '50');
    assert.deepEqual(result.afterToggles, ['100','45.359237','50']);
    assert.deepEqual(result.restored, [['lb','100'],['kg','50']]);
    assert.deepEqual(result.saved.exercises.map(e=>e.weightUnit), ['lb','kg']);
    assert.deepEqual(result.repeated, ['100','50']);
    assert.deepEqual(result.repeatedKg, ['45.4','45.359237']);
    assert.deepEqual(result.editor, [['100','lb'],['50','кг']]);
    assert.equal(result.editorStored, '45.359237');
    assert.equal(result.favoritePreserved, true);
    assert.equal(result.detailHasInjectedElement, false);
    assert.equal(result.measurementsHaveInjectedElement, false);
    assert.equal(result.xssExecuted, 0);
    assert.equal(result.malformedSessionsLength, 0);
    assert.equal(result.localDate, '2026-09-12');
    assert.deepEqual(errors, []);
    console.log('PASS: units, drafts, history editor, local dates, safe rendering, malformed imports, favorite preservation, no browser errors');
  } finally { await browser.close(); }
})().catch(e=>{console.error(e);process.exitCode=1;});
