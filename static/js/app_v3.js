function serverLog(type, message) {
    fetch('/api/log', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: type, message: message })
    }).catch(e => console.error(e));
}

window.addEventListener('error', function(e) {
    serverLog('ERROR', "Message: " + e.message + " | File: " + e.filename + " | Line: " + e.lineno);
});

// --- LLM Model Pricing & Cost Calculation ---
let MODEL_PRICING = {};
let MASTER_MODELS = { openai: [], claude: [], gemini: [] };

async function fetchLlmPricing() {
    try {
        const res = await fetch('/api/llm/pricing');
        const data = await res.json();
        if (data.status === 'success' && data.pricing) {
            MODEL_PRICING = {};
            MASTER_MODELS = { openai: [], claude: [], gemini: [] };
            data.pricing.forEach(item => {
                MODEL_PRICING[item.model_name] = {
                    input: item.input_cost_1m,
                    output: item.output_cost_1m,
                    provider: item.provider
                };
                if (item.model_name !== 'USD_JPY') {
                    const prov = item.provider.toLowerCase();
                    if (prov.includes('openai')) {
                        MASTER_MODELS.openai.push(item.model_name);
                    } else if (prov.includes('anthropic') || prov.includes('claude')) {
                        MASTER_MODELS.claude.push(item.model_name);
                    } else if (prov.includes('google') || prov.includes('gemini')) {
                        MASTER_MODELS.gemini.push(item.model_name);
                    }
                }
            });
        }
    } catch (e) {
        console.error('LLM価格表のフェッチに失敗しました。デフォルトの推定ロジックのみ動作します。', e);
    }
}

function getModelPricing(modelName) {
    if (!modelName) return null;
    const nameLower = modelName.toLowerCase();
    
    // 完全一致
    if (MODEL_PRICING[modelName]) return MODEL_PRICING[modelName];
    
    // 小文字
    for (const key of Object.keys(MODEL_PRICING)) {
        if (key.toLowerCase() === nameLower) {
            return MODEL_PRICING[key];
        }
    }
    
    // 部分一致
    for (const key of Object.keys(MODEL_PRICING)) {
        const keyLower = key.toLowerCase();
        if (nameLower.includes(keyLower) || keyLower.includes(nameLower)) {
            return MODEL_PRICING[key];
        }
    }
    
    return null;
}

function getUsdJpyRate() {
    if (MODEL_PRICING && MODEL_PRICING['USD_JPY']) {
        return MODEL_PRICING['USD_JPY'].input;
    }
    return 155;
}

function calculateCost(modelName, tokens, inputTokens, outputTokens, rate = null) {
    const pricing = getModelPricing(modelName);
    if (!pricing) return null;
    
    const finalRate = rate || getUsdJpyRate();
    
    let inT = inputTokens;
    let outT = outputTokens;
    
    if (inT === undefined || outT === undefined || inT === null || outT === null) {
        // tokens のみある場合の推定
        inT = Math.round(tokens * 0.8);
        outT = tokens - inT;
    }
    
    const inputCost = (inT / 1000000) * pricing.input;
    const outputCost = (outT / 1000000) * pricing.output;
    const totalCostUSD = inputCost + outputCost;
    const totalCostJPY = totalCostUSD * finalRate;
    
    return {
        usd: totalCostUSD,
        jpy: totalCostJPY,
        pricing: pricing,
        inputTokens: inT,
        outputTokens: outT
    };
}

// --- State ---
let masters = {};
let allTasksRaw = [];
let availableProjects = [];
let currentProject = 'Sample';
let openProjects = []; // 開かれているプロジェクトタブ
let hasUnsavedChanges = false;

let historyStack = [];
let redoStack = [];
let isUndoRedoAction = false;
let copiedTaskRaw = null;
let deadlinesRaw = [];

// Gantt State
let ganttConfig = {
    dayWidth: 30,
    rowHeight: 36,
    uiScale: 1.0,
    startDate: moment().subtract(1, 'years').startOf('month'),
    endDate: moment().add(2, 'years').startOf('month'),
    totalDays: 0,
    groups: [],
    collapsedGroups: new Set()
};

// DOM Elements
const els = {
    ganttHeaderContent: document.getElementById('gantt-header-content'),
    ganttBody: document.getElementById('gantt-body'),
    ganttBodyContent: document.getElementById('gantt-body-content'),
    ganttGrid: document.getElementById('gantt-grid'),
    ganttRows: document.getElementById('gantt-rows'),
    ganttTasks: document.getElementById('gantt-tasks'),
    ganttProgressLine: document.getElementById('gantt-progress-line'),
    ganttTodayLine: document.getElementById('gantt-today-line'),
    ganttDependencyLines: document.getElementById('gantt-dependency-lines'),
    crosshairCol: document.getElementById('gantt-crosshair-col'),
    crosshairRow: document.getElementById('gantt-crosshair-row'),
    unsavedBadge: document.getElementById('unsaved-badge'),
    toggleProgressLine: document.getElementById('toggle-progress-line')
};

let currentTaskContextId = null;
let selectedTaskIds = new Set();
let lastMouseTime = null;
let lastMouseGroup = null;
let currentHoverDate = null;
let currentHoverGroup = null;
let dependencyDragSourceId = null;
let dependencyDragCurrentPos = null;
let insertTargetIndex = -1; // 新規タスク挿入位置

// --- Initialization ---
async function init() {
    await fetchLlmPricing();
    await fetchProjects();
    await reloadData();
    setupScrollSync();
    setupMouseTracking();
    setupZoom();
    setupMiscEvents();
    scrollToDate(moment());
}

async function fetchProjects() {
    const res = await fetch('/api/projects');
    availableProjects = await res.json();
    
    const stored = localStorage.getItem('openProjects');
    if (stored) {
        try {
            openProjects = JSON.parse(stored);
        } catch (e) {}
    }
    
    // 有効なプロジェクトのみ残す
    openProjects = openProjects.filter(p => availableProjects.includes(p));
    
    if (openProjects.length === 0 && availableProjects.length > 0) {
        openProjects = [availableProjects[0]];
    }
    
    const storedCurrent = localStorage.getItem('currentProject');
    if (storedCurrent && openProjects.includes(storedCurrent)) {
        currentProject = storedCurrent;
    } else if (openProjects.length > 0) {
        currentProject = openProjects[0];
    } else {
        currentProject = null;
    }

    renderTabs();
    if (currentProject) {
        const meLink = document.getElementById('master-editor-link');
        if (meLink) meLink.href = `/master_editor?project=${currentProject}`;
    }
}

function renderTabs() {
    const container = document.getElementById('project-tabs-container');
    if (!container) return;
    
    let html = '';
    openProjects.forEach(p => {
        const isActive = p === currentProject;
        const activeClasses = isActive
            ? 'bg-white text-blue-800 border-t-2 border-blue-500 font-bold'
            : 'bg-gray-300 text-gray-700 hover:bg-gray-200 cursor-pointer';
        
        html += `
            <div class="px-4 py-2 rounded-t flex items-center group transition-colors ${activeClasses}"
                 onclick="switchProjectTab('${p}')">
                <span>${p}</span>
                <span class="ml-2 text-gray-500 hover:text-red-500 font-bold opacity-0 group-hover:opacity-100 transition-opacity"
                      onclick="closeProjectTab(event, '${p}')">&times;</span>
            </div>
        `;
    });
    
    html += `
        <div class="px-3 py-2 bg-gray-300 text-gray-600 rounded-t hover:bg-gray-200 cursor-pointer font-bold"
             onclick="openNewProjectDialog()">＋</div>
    `;
    
    container.innerHTML = html;
    
    localStorage.setItem('openProjects', JSON.stringify(openProjects));
    if (currentProject) localStorage.setItem('currentProject', currentProject);
}

async function switchProjectTab(p) {
    if (p === currentProject) return;
    if (hasUnsavedChanges && !confirm('未保存の変更がありますが、プロジェクトを切り替えますか？')) return;
    
    currentProject = p;
    hasUnsavedChanges = false;
    els.unsavedBadge.classList.add('hidden');
    renderTabs();
    await reloadData();
    const meLink = document.getElementById('master-editor-link');
    if (meLink) meLink.href = `/master_editor?project=${currentProject}`;
}

function closeProjectTab(e, p) {
    e.stopPropagation();
    if (p === currentProject && hasUnsavedChanges && !confirm('未保存の変更がありますが、タブを閉じますか？')) return;
    
    openProjects = openProjects.filter(x => x !== p);
    
    if (openProjects.length === 0) {
        currentProject = null;
    } else if (currentProject === p) {
        currentProject = openProjects[openProjects.length - 1];
    }
    
    renderTabs();
    if (currentProject) {
        hasUnsavedChanges = false;
        els.unsavedBadge.classList.add('hidden');
        reloadData().then(() => {
            const meLink = document.getElementById('master-editor-link');
            if (meLink) meLink.href = `/master_editor?project=${currentProject}`;
        });
    } else {
        els.ganttTasks.innerHTML = '';
        els.ganttHeaderContent.innerHTML = '';
        els.ganttGrid.innerHTML = '';
        els.ganttRows.innerHTML = '';
    }
}

function openNewProjectDialog() {
    const sel = document.getElementById('new-tab-select');
    sel.innerHTML = '<option value="">(選択しない)</option>' +
        availableProjects.map(p => `<option value="${p}">${p}</option>`).join('');
    document.getElementById('new-project-name').value = '';
    document.getElementById('new-project-dialog').classList.remove('hidden');
}

function closeNewProjectDialog() {
    document.getElementById('new-project-dialog').classList.add('hidden');
}

async function applyNewProject() {
    const selVal = document.getElementById('new-tab-select').value;
    const inputVal = document.getElementById('new-project-name').value.trim();
    
    const targetProject = inputVal || selVal;
    if (!targetProject) {
        alert('プロジェクトを選択するか、名前を入力してください。');
        return;
    }
    
    closeNewProjectDialog();
    
    if (!openProjects.includes(targetProject)) {
        openProjects.push(targetProject);
        if (!availableProjects.includes(targetProject)) {
            availableProjects.push(targetProject);
            // 新規作成された場合、バックエンドにもディレクトリを作成させるために一度APIを叩く
            await fetch(`/api/tasks?project=${targetProject}`);
        }
    }
    
    await switchProjectTab(targetProject);
}

async function fetchMasters() {
    const res = await fetch(`/api/masters?project=${currentProject}`);
    masters = await res.json();
    if (masters.section) {
        const filterSel = document.getElementById('filter-section');
        if (filterSel) {
            const currentVal = filterSel.value;
            filterSel.innerHTML = '<option value="">全セクション表示</option>' +
                masters.section.map(s => `<option value="${s.section_id}">${s.section_name}</option>`).join('');
            if (Array.from(filterSel.options).some(o => o.value === currentVal)) filterSel.value = currentVal;
        }
    }
    if (masters.member) {
        const filterMemberList = document.getElementById('filter-member-list');
        if (filterMemberList) {
            // 現在のチェック状態を保存（あれば）
            const currentSelected = window.getSelectedMembers ? window.getSelectedMembers() : [];
            
            let html = '';
            
            // セクションごとにグループ化
            if (masters.section) {
                masters.section.forEach(s => {
                    const secMembers = masters.member.filter(m => m.section_id === s.section_id);
                    if (secMembers.length === 0) return;
                    
                    const childrenHTML = secMembers.map(m => `
                        <label class="flex items-center space-x-2 px-2 py-1 hover:bg-gray-50 rounded cursor-pointer member-filter-item" data-section="${s.section_id}">
                            <input type="checkbox" class="member-filter-cb" value="${m.member_id}" data-name="${m.member_name}" data-section="${s.section_id}" ${currentSelected.includes(m.member_id) ? 'checked' : ''}>
                            <span class="text-xs">${m.member_name}${m.display_name ? ' (' + m.display_name + ')' : ''}</span>
                        </label>
                    `).join('');
                    
                    html += `
                    <div class="member-filter-section-group mb-2 border-b border-gray-100 pb-2 last:border-0 last:pb-0" data-section="${s.section_id}">
                        <label class="flex items-center space-x-2 px-2 py-1 bg-gray-100 hover:bg-gray-200 rounded cursor-pointer font-bold text-[11px] select-none mb-1">
                            <input type="checkbox" class="section-filter-cb" value="${s.section_id}" data-name="${s.section_name}">
                            <span>📁 ${s.section_name}</span>
                        </label>
                        <div class="pl-4 ml-1 space-y-1 member-filter-children-container">
                            ${childrenHTML}
                        </div>
                    </div>
                    `;
                });
                
                // セクションに所属していないメンバー
                const otherMembers = masters.member.filter(m => !m.section_id || !masters.section.some(s => s.section_id === m.section_id));
                if (otherMembers.length > 0) {
                    const childrenHTML = otherMembers.map(m => `
                        <label class="flex items-center space-x-2 px-2 py-1 hover:bg-gray-50 rounded cursor-pointer member-filter-item" data-section="others">
                            <input type="checkbox" class="member-filter-cb" value="${m.member_id}" data-name="${m.member_name}" data-section="others" ${currentSelected.includes(m.member_id) ? 'checked' : ''}>
                            <span class="text-xs">${m.member_name}${m.display_name ? ' (' + m.display_name + ')' : ''}</span>
                        </label>
                    `).join('');
                    
                    html += `
                    <div class="member-filter-section-group mb-2 border-b border-gray-100 pb-2 last:border-0 last:pb-0" data-section="others">
                        <label class="flex items-center space-x-2 px-2 py-1 bg-gray-100 hover:bg-gray-200 rounded cursor-pointer font-bold text-[11px] select-none mb-1">
                            <input type="checkbox" class="section-filter-cb" value="others" data-name="その他">
                            <span>📁 その他</span>
                        </label>
                        <div class="pl-4 ml-1 space-y-1 member-filter-children-container">
                            ${childrenHTML}
                        </div>
                    </div>
                    `;
                }
            } else {
                // セクションマスタがない場合は通常通り並べる
                html = masters.member.map(m => `
                    <label class="flex items-center space-x-2 px-2 py-1 hover:bg-gray-100 rounded cursor-pointer member-filter-item">
                        <input type="checkbox" class="member-filter-cb" value="${m.member_id}" data-name="${m.member_name}" ${currentSelected.includes(m.member_id) ? 'checked' : ''}>
                        <span>${m.member_name}${m.display_name ? ' (' + m.display_name + ')' : ''}</span>
                    </label>
                `).join('');
            }
            
            filterMemberList.innerHTML = html;

            // 親チェックボックス（セクション）の変更時連動
            document.querySelectorAll('.section-filter-cb').forEach(secCb => {
                secCb.addEventListener('change', (e) => {
                    const secId = e.target.value;
                    const isChecked = e.target.checked;
                    
                    // 配下の子メンバーに適用
                    const childCbs = document.querySelectorAll(`.member-filter-cb[data-section="${secId}"]`);
                    childCbs.forEach(childCb => {
                        if (childCb.checked !== isChecked) {
                            childCb.checked = isChecked;
                        }
                    });
                    
                    updateMemberFilterText();
                    renderGantt();
                });
            });

            // 子メンバーのチェック状態から親の状態を更新する関数
            function updateSectionCbState(secId) {
                const secCb = document.querySelector(`.section-filter-cb[value="${secId}"]`);
                if (!secCb) return;
                
                const childCbs = document.querySelectorAll(`.member-filter-cb[data-section="${secId}"]`);
                if (childCbs.length === 0) return;
                
                const checkedCount = Array.from(childCbs).filter(cb => cb.checked).length;
                
                if (checkedCount === childCbs.length) {
                    secCb.checked = true;
                    secCb.indeterminate = false;
                } else if (checkedCount === 0) {
                    secCb.checked = false;
                    secCb.indeterminate = false;
                } else {
                    secCb.checked = false;
                    secCb.indeterminate = true; // 中間状態
                }
            }

            // 子メンバーチェックボックスの変更時連動
            document.querySelectorAll('.member-filter-cb').forEach(cb => {
                cb.addEventListener('change', (e) => {
                    const secId = e.target.getAttribute('data-section');
                    updateSectionCbState(secId);
                    updateMemberFilterText();
                    renderGantt();
                });
            });

            // 初期ロード時の親（セクション）のチェックボックス状態を同期
            if (masters.section) {
                const sectionsList = masters.section.map(s => s.section_id).concat(['others']);
                sectionsList.forEach(secId => {
                    updateSectionCbState(secId);
                });
            }

            updateMemberFilterText();
        }
    }
    if (masters.status) {
        const filterStatusList = document.getElementById('filter-status-list');
        if (filterStatusList) {
            // 現在のチェック状態を保存（あれば）
            const currentSelected = window.getSelectedStatuses ? window.getSelectedStatuses() : [];
            
            filterStatusList.innerHTML = masters.status.map(s => `
                <label class="flex items-center space-x-2 px-2 py-1 hover:bg-gray-100 rounded cursor-pointer status-filter-item">
                    <input type="checkbox" class="status-filter-cb" value="${s.status_id}" data-name="${s.status_name}" ${currentSelected.includes(s.status_id) ? 'checked' : ''}>
                    <span>${s.status_name}</span>
                </label>
            `).join('');

            // イベントリスナーの再設定
            document.querySelectorAll('.status-filter-cb').forEach(cb => {
                cb.addEventListener('change', () => {
                    updateStatusFilterText();
                    renderGantt();
                });
            });
            updateStatusFilterText();
        }
    }
}

async function fetchTasks() {
    const res = await fetch(`/api/tasks?project=${currentProject}`);
    const tasks = await res.json();
    const uniqueMap = new Map();
    tasks.forEach(t => uniqueMap.set(t.task_id, t));
    allTasksRaw = Array.from(uniqueMap.values());
}

// メンバーフィルター用ヘルパー
window.getSelectedMembers = function() {
    const cbs = document.querySelectorAll('.member-filter-cb:checked');
    return Array.from(cbs).map(cb => cb.value);
};

function updateMemberFilterText() {
    const selected = window.getSelectedMembers();
    const btnText = document.getElementById('filter-member-text');
    if (!btnText) return;
    
    if (selected.length === 0) {
        btnText.textContent = '担当者(全て)';
    } else if (selected.length === 1) {
        const cb = document.querySelector(`.member-filter-cb[value="${selected[0]}"]`);
        btnText.textContent = cb ? cb.getAttribute('data-name') : '1人選択';
    } else {
        btnText.textContent = `${selected.length}人選択`;
    }
}

// ステータスフィルター用ヘルパー
window.getSelectedStatuses = function() {
    const cbs = document.querySelectorAll('.status-filter-cb:checked');
    return Array.from(cbs).map(cb => cb.value);
};

function updateStatusFilterText() {
    const selected = window.getSelectedStatuses();
    const btnText = document.getElementById('filter-status-text');
    if (!btnText) return;
    
    if (selected.length === 0) {
        btnText.textContent = 'ステータス(全て)';
    } else if (selected.length === 1) {
        const cb = document.querySelector(`.status-filter-cb[value="${selected[0]}"]`);
        btnText.textContent = cb ? cb.getAttribute('data-name') : '1つ選択';
    } else {
        btnText.textContent = `${selected.length}個選択`;
    }
}

async function fetchDeadlines() {
    const res = await fetch(`/api/deadlines?project=${currentProject}`);
    deadlinesRaw = await res.json();
}

async function reloadData() {
    historyStack = [];
    redoStack = [];
    updateUndoRedoButtons();
    await fetchMasters();
    await fetchTasks();
    await fetchDeadlines();
    renderGantt();
}

function markUnsaved() {
    hasUnsavedChanges = true;
    els.unsavedBadge.classList.remove('hidden');
}

function saveHistory() {
    if (isUndoRedoAction) return;
    const currentState = JSON.stringify(allTasksRaw);
    historyStack.push(currentState);
    if (historyStack.length > 50) historyStack.shift();
    redoStack = [];
    updateUndoRedoButtons();
}

function updateUndoRedoButtons() {
    const btnUndo = document.getElementById('btn-undo');
    const btnRedo = document.getElementById('btn-redo');
    if(btnUndo) btnUndo.disabled = historyStack.length === 0;
    if(btnRedo) btnRedo.disabled = redoStack.length === 0;
}

function performUndo() {
    if (historyStack.length === 0) return;
    isUndoRedoAction = true;
    redoStack.push(JSON.stringify(allTasksRaw));
    allTasksRaw = JSON.parse(historyStack.pop());
    isUndoRedoAction = false;
    updateUndoRedoButtons();
    markUnsaved();
    renderGantt();
}

function performRedo() {
    if (redoStack.length === 0) return;
    isUndoRedoAction = true;
    historyStack.push(JSON.stringify(allTasksRaw));
    allTasksRaw = JSON.parse(redoStack.pop());
    isUndoRedoAction = false;
    updateUndoRedoButtons();
    markUnsaved();
    renderGantt();
}

// --- Layout & Scroll Sync ---
function setupScrollSync() {
    let ticking = false;
    els.ganttHeaderContent.style.willChange = 'transform';
    els.ganttBody.addEventListener('scroll', (e) => {
        if (!ticking) {
            window.requestAnimationFrame(() => {
                const scrollLeft = els.ganttBody.scrollLeft;
                els.ganttHeaderContent.style.transform = `translate3d(-${scrollLeft}px, 0, 0)`;
                
                const stickyLabels = els.ganttHeaderContent.querySelectorAll('.js-sticky-label');
                stickyLabels.forEach(label => {
                    const parent = label.parentElement;
                    const parentLeft = parseInt(parent.style.left) || 0;
                    const parentWidth = parseInt(parent.style.width) || 0;
                    const labelWidth = label.offsetWidth || 50;
                    
                    let shift = scrollLeft - parentLeft + 8; // デフォルトで8pxの余白
                    if (shift < 8) shift = 8;
                    if (shift > parentWidth - labelWidth - 8) shift = parentWidth - labelWidth - 8;
                    
                    label.style.transform = `translate3d(${shift}px, 0, 0)`;
                });
                
                ticking = false;
            });
            ticking = true;
        }
    });
}

function scrollToDate(dateMoment) {
    const days = dateMoment.diff(ganttConfig.startDate, 'days');
    const x = days * ganttConfig.dayWidth;
    els.ganttBody.scrollLeft = Math.max(0, x - els.ganttBody.clientWidth / 2);
}

// --- Date Math ---
function dateToX(dateStrOrMoment) {
    const m = moment(dateStrOrMoment);
    return m.diff(ganttConfig.startDate, 'days') * ganttConfig.dayWidth;
}
function xToDate(x) {
    const days = Math.floor(x / ganttConfig.dayWidth);
    return ganttConfig.startDate.clone().add(days, 'days');
}

function getMasterItem(type, idField, id) {
    if (!masters[type]) return null;
    return masters[type].find(m => m[idField] === id);
}

// --- Rendering ---
let currentFilteredTasks = [];

function updateFilteredTasks() {
    const filterTextElem = document.getElementById('filter-text');
    const filterQuery = filterTextElem && filterTextElem.value.trim() !== '' ? filterTextElem.value.trim().toLowerCase() : '';
    
    const selectedMembers = window.getSelectedMembers ? window.getSelectedMembers() : [];
    const selectedStatuses = window.getSelectedStatuses ? window.getSelectedStatuses() : [];

    currentFilteredTasks = allTasksRaw.filter(t => {
        if (selectedMembers.length > 0 && !selectedMembers.includes(t.member_id)) return false;
        if (selectedStatuses.length > 0 && !selectedStatuses.includes(t.status_id)) return false;
        
        if (filterQuery !== '') {
            const charName = t.char_id ? getMasterItem('character', 'char_id', t.char_id)?.char_name || '' : '';
            const relName = t.release_id ? getMasterItem('release', 'release_id', t.release_id)?.release_name || '' : '';
            const memberName = t.member_id ? getMasterItem('member', 'member_id', t.member_id)?.member_name || '' : '';
            const sectionName = t.section_id ? getMasterItem('section', 'section_id', t.section_id)?.section_name || '' : '';
            
            const searchTarget = `${t.task_name} ${charName} ${relName} ${memberName} ${sectionName}`.toLowerCase();
            if (!searchTarget.includes(filterQuery)) return false;
        }
        return true;
    });
}

function renderGantt() {
    updateFilteredTasks();
    
    ganttConfig.totalDays = ganttConfig.endDate.diff(ganttConfig.startDate, 'days');
    const totalWidth = ganttConfig.totalDays * ganttConfig.dayWidth;
    
    els.ganttHeaderContent.style.width = `${totalWidth}px`;
    els.ganttGrid.style.width = `${totalWidth}px`;
    els.ganttRows.style.width = `${totalWidth}px`;
    els.ganttTasks.style.width = `${totalWidth}px`;
    els.ganttBodyContent.style.width = `${totalWidth}px`;
    if (els.ganttDependencyLines) {
        els.ganttDependencyLines.style.width = `${totalWidth}px`;
    }

    buildGroupsList();
    renderHeaderAndGrid(totalWidth);
    renderRows();
    renderTasks();
    renderDependencyLines();
    renderProgressLine();
    renderTodayLine();
}

function renderTodayLine() {
    if (!els.ganttTodayLine) return;
    
    const today = moment().startOf('day');
    
    // 表示期間外なら描画しない
    if (today.isBefore(ganttConfig.startDate) || today.isAfter(ganttConfig.endDate)) {
        els.ganttTodayLine.innerHTML = '';
        return;
    }
    
    const x = dateToX(today);
    
    const html = `
        <div class="absolute top-0 bottom-0 pointer-events-none flex flex-col items-center" style="left: ${x}px; width: ${ganttConfig.dayWidth}px; z-index: 25;">
            <!-- 中心にオレンジ色の縦線を引く（dayWidthのちょうど真ん中か左端か。通常、今日という1日の「枠」の左端か真ん中。ここでは左端に線を引くなら width:0 で left:x、今回は枠の中心に引いてみる） -->
            <div class="absolute left-1/2 top-0 bottom-0 w-[2px] bg-orange-500 shadow-[0_0_8px_rgba(249,115,22,0.8)] -translate-x-1/2"></div>
        </div>
    `;
    els.ganttTodayLine.innerHTML = html;
}

function buildGroupsList() {
    ganttConfig.groups = [];
    if (!masters.release || !masters.character) return;

    // タスクから必要な組み合わせを抽出
    const activeReleases = new Set();
    const activeChars = new Set();
    
    currentFilteredTasks.forEach(t => {
        if (t.release_id) activeReleases.add(t.release_id);
        if (t.release_id && t.char_id) activeChars.add(`${t.release_id}_${t.char_id}`);
    });

    masters.release.forEach(rel => {
        const relId = rel.release_id;
        if (!activeReleases.has(relId)) return;

        ganttConfig.groups.push({
            id: relId, type: 'release', name: rel.release_name, level: 0, raw: rel
        });
        
        if (ganttConfig.collapsedGroups.has(relId)) return;

        // タスクの配列順（登場順）でキャラクターの表示順を決定する
        const charsInThisRelease = [];
        const seenChars = new Set();
        currentFilteredTasks.forEach(t => {
            if (t.release_id === relId && t.char_id && !seenChars.has(t.char_id)) {
                seenChars.add(t.char_id);
                const charObj = masters.character.find(c => c.char_id === t.char_id);
                if (charObj) charsInThisRelease.push(charObj);
            }
        });

        charsInThisRelease.forEach(char => {
            const charId = `${rel.release_id}_${char.char_id}`;

            ganttConfig.groups.push({
                id: charId, type: 'character', name: `${char.char_name} (${char.costume_name})`, parentId: relId, level: 1, raw: char
            });
            
            if (ganttConfig.collapsedGroups.has(charId)) return;
            
            // 対象キャラクターのタスクを抽出してテトリススタックをシミュレーションし、必要な行数（Lane数）を計算する
            const charTasks = currentFilteredTasks.filter(t => t.release_id === relId && t.char_id === char.char_id);
            const sortedCharTasks = [...charTasks].sort((a, b) => moment(a.start_date).diff(moment(b.start_date)));
            
            // 実際に使用されているlaneを抽出し、空行を飛ばして連番にマッピングする
            const usedLanes = new Set();
            sortedCharTasks.forEach(t => {
                const laneIdx = parseInt(t.lane) || 1;
                usedLanes.add(laneIdx);
            });
            
            const sortedUsedLanes = Array.from(usedLanes).sort((a, b) => a - b);
            const laneMapping = {};
            sortedUsedLanes.forEach((oldLane, idx) => {
                laneMapping[oldLane] = idx + 1; // 1からの連番に詰める
            });
            
            // 詰め直したLaneごとにテトリススタックを計算し、必要な行数を割り出す
            const laneStacks = {};
            let maxLaneNeeded = 1;
            
            sortedCharTasks.forEach(t => {
                const oldLaneIdx = parseInt(t.lane) || 1;
                const mappedLaneIdx = laneMapping[oldLaneIdx] || 1;
                
                const startM = moment(t.start_date).startOf('day');
                const endM = moment(t.end_date).add(1, 'days').startOf('day');
                const x = startM.valueOf();
                const endX = endM.valueOf();
                
                if (!laneStacks[mappedLaneIdx]) laneStacks[mappedLaneIdx] = [];
                let level = 0;
                for (let i = 0; i < laneStacks[mappedLaneIdx].length; i++) {
                    if (laneStacks[mappedLaneIdx][i] <= x) {
                        level = i;
                        break;
                    }
                    level = i + 1;
                }
                laneStacks[mappedLaneIdx][level] = endX;
                
                // mappedLaneIdxを基準に、はみ出たlevel分を加算
                const neededForThisTask = mappedLaneIdx + level;
                if (neededForThisTask > maxLaneNeeded) {
                    maxLaneNeeded = neededForThisTask;
                }
            });
            
            // 少なくとも1行は表示する。
            const requiredLanes = Math.max(1, maxLaneNeeded);
            
            // mapping情報をキャラクターグループのrawに持たせておく（renderTasksで使うため）
            char.laneMapping = laneMapping;
            
            for (let i = 1; i <= requiredLanes; i++) {
                const laneId = `${charId}_LANE${i}`;
                ganttConfig.groups.push({
                    id: laneId, type: 'lane', name: `Lane ${i}`, parentId: charId, level: 2
                });
            }
        });
    });
    
    const totalHeight = ganttConfig.groups.length * ganttConfig.rowHeight;
    // グループが全くない（タスクがない）場合でも背景グリッドが消えないよう、コンテナの高さ以上を確保する
    const containerHeight = els.ganttBody.clientHeight;
    els.ganttBodyContent.style.minHeight = `${Math.max(totalHeight, containerHeight)}px`;
}

function renderHeaderAndGrid(totalWidth) {
    let headerHtml = '';
    let gridHtml = '';
    let currentM = ganttConfig.startDate.clone();
    
    let heatmapHtml = '<div class="absolute left-0 w-full border-b border-gray-300 bg-white" style="top:0px; height:48px;">';
    let yearHtml = '<div class="absolute left-0 w-full flex border-b border-gray-300 bg-white" style="top:48px; height:24px;">';
    let monthHtml = '<div class="absolute left-0 w-full flex border-b border-gray-300 bg-white" style="top:72px; height:24px;">';
    let bottomHtml = '<div class="absolute left-0 w-full flex border-b border-gray-400 bg-white" style="top:96px; height:24px;">';
    
    let currentYear = currentM.year();
    let yearStartDays = 0;
    
    let currentMonth = currentM.month();
    let monthStartDays = 0;
    
    const isWeekView = ganttConfig.dayWidth < 12;

    let weekStartDays = 0;
    let currentWeekNum = 1;

    // --- ヒートマップ計算 ---
    const filterSectionId = document.getElementById('filter-section') ? document.getElementById('filter-section').value : '';
    const taskDates = [];
    allTasksRaw.forEach(t => {
        if (filterSectionId && t.section_id !== filterSectionId) return;
        const startM = moment(t.start_date).startOf('day');
        const endM = moment(t.end_date).startOf('day');
        for (let m = startM.clone(); m.isSameOrBefore(endM); m.add(1, 'days')) {
            const dStr = m.format('YYYY-MM-DD');
            const dayOfWeek = m.day();
            const masterHoliday = masters.holiday ? masters.holiday.find(h => h.holiday_date === dStr) : null;
            if (masterHoliday || dayOfWeek === 0 || dayOfWeek === 6) continue;
            taskDates.push(dStr);
        }
    });
    const counts = {};
    taskDates.forEach(d => counts[d] = (counts[d] || 0) + 1);

    let currentWeekMaxCount = 0;

    for (let d = 0; d < ganttConfig.totalDays; d++) {
        const dateStr = currentM.format('YYYY-MM-DD');
        const dayOfWeek = currentM.day();
        const dateOfMonth = currentM.date();
        
        let bgClass = '';
        const masterHoliday = masters.holiday ? masters.holiday.find(h => h.holiday_date === dateStr) : null;
        if (masterHoliday) {
            bgClass = masterHoliday.holiday_type === 'public' ? 'bg-sunday-public' : 'bg-company-holiday';
        } else if (dayOfWeek === 0) {
            bgClass = 'bg-sunday-public';
        } else if (dayOfWeek === 6) {
            bgClass = 'bg-saturday';
        }
        
        let borderClass = 'gantt-grid-line pointer-events-none';
        if (dateOfMonth === 1) borderClass += ' gantt-grid-line-month';
        else if (dayOfWeek === 1) borderClass += ' gantt-grid-line-week';
        
        gridHtml += `<div class="absolute top-0 bottom-0 pointer-events-none ${bgClass} ${borderClass}" style="left:${d * ganttConfig.dayWidth}px; width:${ganttConfig.dayWidth}px;"></div>`;
        
        let dayBorder = borderClass.replace('gantt-grid-line pointer-events-none', '').trim();
        
        const count = counts[dateStr] || 0;
        currentWeekMaxCount = Math.max(currentWeekMaxCount, count);

        if (isWeekView) {
            const nextM = currentM.clone().add(1, 'days');
            if (nextM.day() === 1 || nextM.date() === 1 || d === ganttConfig.totalDays - 1) {
                const width = (d - weekStartDays + 1) * ganttConfig.dayWidth;
                const left = weekStartDays * ganttConfig.dayWidth;
                if (dateOfMonth === 1) currentWeekNum = 1;
                bottomHtml += `<div class="gantt-header-cell ${dayBorder}" style="left:${left}px; width:${width}px; border-left:1px dashed #888;">${currentWeekNum}W</div>`;
                
                if (currentWeekMaxCount > 0) {
                    let heatColor = 'rgba(134, 239, 172, 0.8)';
                    if (currentWeekMaxCount >= 5) heatColor = 'rgba(239, 68, 68, 0.8)';
                    else if (currentWeekMaxCount >= 3) heatColor = 'rgba(245, 158, 11, 0.8)';
                    if (filterSectionId) heatColor = 'rgba(96, 165, 250, 0.8)';

                    const maxLineHeight = 5;
                    const heightPercent = Math.min((currentWeekMaxCount / maxLineHeight) * 100, 100);
                    
                    heatmapHtml += `
                        <div class="absolute bottom-0 border-r border-gray-200 pointer-events-none" style="left:${left}px; width:${width}px; height:48px;">
                            <div class="absolute bottom-0 left-0 w-full" style="height:${heightPercent}%; background-color:${heatColor};"></div>
                            <div class="absolute top-0 left-0 w-full h-full flex items-center justify-center text-[10px] font-bold text-gray-800">${currentWeekMaxCount}</div>
                        </div>
                    `;
                }

                weekStartDays = d + 1;
                currentWeekNum++;
                currentWeekMaxCount = 0;
            }
        } else {
            bottomHtml += `<div class="gantt-header-cell ${dayBorder} ${bgClass}" style="left:${d * ganttConfig.dayWidth}px; width:${ganttConfig.dayWidth}px;">${dateOfMonth}</div>`;
            
            if (count > 0) {
                let heatColor = 'rgba(134, 239, 172, 0.8)';
                if (count >= 5) heatColor = 'rgba(239, 68, 68, 0.8)';
                else if (count >= 3) heatColor = 'rgba(245, 158, 11, 0.8)';
                if (filterSectionId) heatColor = 'rgba(96, 165, 250, 0.8)';

                const maxLineHeight = 5;
                const heightPercent = Math.min((count / maxLineHeight) * 100, 100);
                
                heatmapHtml += `
                    <div class="absolute bottom-0 border-r border-gray-200 pointer-events-none" style="left:${d * ganttConfig.dayWidth}px; width:${ganttConfig.dayWidth}px; height:48px;">
                        <div class="absolute bottom-0 left-0 w-full" style="height:${heightPercent}%; background-color:${heatColor};"></div>
                        <div class="absolute top-0 left-0 w-full h-full flex items-center justify-center text-[10px] font-bold text-gray-800">${count}</div>
                    </div>
                `;
            }
        }
        
        currentM.add(1, 'days');
        
        if (currentM.month() !== currentMonth || d === ganttConfig.totalDays - 1) {
            const width = (d - monthStartDays + 1) * ganttConfig.dayWidth;
            const left = monthStartDays * ganttConfig.dayWidth;
            monthHtml += `<div class="gantt-header-cell gantt-grid-line-month overflow-hidden" style="left:${left}px; width:${width}px; height:100%; font-size:14px; justify-content: flex-start;"><span class="js-sticky-label inline-block z-10" style="transform: translate3d(8px, 0, 0);">${currentMonth + 1}月</span></div>`;
            monthStartDays = d + 1;
            currentMonth = currentM.month();
            if (isWeekView) currentWeekNum = 1;
        }
        
        if (currentM.year() !== currentYear || d === ganttConfig.totalDays - 1) {
            const width = (d - yearStartDays + 1) * ganttConfig.dayWidth;
            const left = yearStartDays * ganttConfig.dayWidth;
            yearHtml += `<div class="gantt-header-cell overflow-hidden" style="left:${left}px; width:${width}px; height:100%; border-left:2px solid #333; font-size:16px; justify-content: flex-start;"><span class="js-sticky-label inline-block z-10" style="transform: translate3d(8px, 0, 0);">${currentYear}年</span></div>`;
            yearStartDays = d + 1;
            currentYear = currentM.year();
        }
    }
    
    yearHtml += '</div>';
    monthHtml += '</div>';
    bottomHtml += '</div>';
    heatmapHtml += '</div>';
    
    els.ganttHeaderContent.innerHTML = yearHtml + monthHtml + bottomHtml + heatmapHtml;
    els.ganttGrid.innerHTML = gridHtml;
}

function renderRows() {
    let html = '';
    ganttConfig.groups.forEach((g, idx) => {
        const top = idx * ganttConfig.rowHeight;
        html += `<div class="gantt-timeline-row" data-group="${g.id}" style="top:${top}px; height:${ganttConfig.rowHeight}px;"></div>`;
    });
    els.ganttRows.innerHTML = html;
}

function toggleGroup(id) {
    if (ganttConfig.collapsedGroups.has(id)) {
        ganttConfig.collapsedGroups.delete(id);
    } else {
        ganttConfig.collapsedGroups.add(id);
    }
    renderGantt();
}

function renderTasks() {
    let html = '';
    const groupY = {};
    ganttConfig.groups.forEach((g, idx) => {
        groupY[g.id] = idx * ganttConfig.rowHeight;
    });

    const taskHeight = 24 * ganttConfig.uiScale;
    const margin = 4 * ganttConfig.uiScale;

    const laneStacks = {};
    
    const sortedTasks = [...currentFilteredTasks].sort((a, b) => moment(a.start_date).diff(moment(b.start_date)));
    sortedTasks.forEach(t => {
        const oldLaneIdx = parseInt(t.lane) || 1;
        // マッピングから描画上のLaneを取得。見つからなければそのまま。
        let mappedLane = oldLaneIdx;
        const charGroup = ganttConfig.groups.find(g => g.type === 'character' && g.id === `${t.release_id}_${t.char_id}`);
        if (charGroup && charGroup.raw && charGroup.raw.laneMapping) {
            mappedLane = charGroup.raw.laneMapping[oldLaneIdx] || oldLaneIdx;
        }
        const parentId = `${t.release_id}_${t.char_id}_LANE${mappedLane}`;
        
        if (ganttConfig.collapsedGroups.has(t.release_id) || ganttConfig.collapsedGroups.has(`${t.release_id}_${t.char_id}`)) return;
        
        const y = groupY[parentId];
        if (y === undefined) return;

        const startM = moment(t.start_date).startOf('day');
        const endM = moment(t.end_date).add(1, 'days').startOf('day');
        
        const x = dateToX(startM);
        const width = Math.max(10, dateToX(endM) - x);
        
        if (!laneStacks[parentId]) laneStacks[parentId] = [];
        let level = 0;
        for (let i = 0; i < laneStacks[parentId].length; i++) {
            if (laneStacks[parentId][i] <= x) {
                level = i;
                break;
            }
            level = i + 1;
        }
        laneStacks[parentId][level] = x + width;

        const section = getMasterItem('section', 'section_id', t.section_id);
        const member = getMasterItem('member', 'member_id', t.member_id);
        const bgColor = section ? section.color : '#3b82f6';
        const memberBg = member ? member.bg_color : '#9ca3af';
        const memberText = member ? member.text_color : '#ffffff';
        const memberName = member ? (member.display_name || member.member_name) : '未定';
        const status = getMasterItem('status', 'status_id', t.status_id);
        const statusColor = status ? status.color : '#9ca3af';
        const statusName = status ? status.status_name : '未着手';
        const progress = parseInt(t.progress) || 0;
        
        const taskTop = y + (level * (taskHeight + margin)) + (ganttConfig.rowHeight - taskHeight) / 2;
        const completedClass = progress === 100 ? 'completed' : '';
        const selectedClass = (selectedTaskIds.has(t.task_id) || (typeof currentTaskContextId !== 'undefined' && currentTaskContextId === t.task_id)) ? 'selected' : '';
        
        html += `
            <div class="gantt-task-item ${completedClass} ${selectedClass}" data-task-id="${t.task_id}" style="left:${x}px; top:${taskTop}px; width:${width}px; height:${taskHeight}px; z-index:20;">
                <div class="gantt-task-bg" style="background-color:${bgColor};"></div>
                <div class="gantt-task-progress" style="width:${progress}%; background-color:${bgColor};"></div>
                <div class="absolute top-0 left-0 w-full z-10" style="height: 4px; background-color:${statusColor}; border-radius: 2px 2px 0 0;"></div>
                <div class="gantt-member-badge" style="background-color:${memberBg}; color:${memberText};">${memberName}</div>
                <div class="gantt-task-name">${t.task_name}</div>
                <div class="gantt-resize-handle gantt-resize-handle-left" data-action="resize-left"></div>
                <div class="gantt-resize-handle gantt-resize-handle-right" data-action="resize-right"></div>
                <div class="gantt-dependency-connector" data-action="connect-dependency" title="ドラッグして他のタスクの左端に繋ぐ">＋</div>
            </div>
        `;
    });

    const parentGroups = ganttConfig.groups.filter(g => g.type === 'release' || g.type === 'character');
    parentGroups.forEach(g => {
        const childTasks = currentFilteredTasks.filter(t => {
            if (g.type === 'release') return t.release_id === g.raw.release_id;
            if (g.type === 'character') return t.release_id === g.parentId && t.char_id === g.raw.char_id;
            return false;
        });
        
        if (childTasks.length === 0 && g.type === 'character') return;

        let minStart = Infinity;
        let maxEnd = -Infinity;
        childTasks.forEach(t => {
            const startX = moment(t.start_date).startOf('day').valueOf();
            const endX = moment(t.end_date).add(1, 'days').startOf('day').valueOf();
            if (startX < minStart) minStart = startX;
            if (endX > maxEnd) maxEnd = endX;
        });

        if (g.type === 'release') {
            const rel = g.raw;
            if (rel.art_deadline) {
                maxEnd = moment(rel.art_deadline).add(1, 'days').startOf('day').valueOf();
            }
            if (minStart === Infinity) {
                if (rel.art_deadline) {
                    minStart = moment(rel.art_deadline).subtract(1, 'months').startOf('day').valueOf();
                } else {
                    return;
                }
            }
        } else {
            if (minStart === Infinity || maxEnd === -Infinity) return;
        }

        const startM = moment(minStart);
        const endM = moment(maxEnd);
        
        const x = dateToX(startM);
        const width = dateToX(endM) - x;
        const y = groupY[g.id];
        
        const taskTop = y + (ganttConfig.rowHeight - taskHeight) / 2;
        const isCollapsed = ganttConfig.collapsedGroups.has(g.id);
        const icon = isCollapsed ? '▶' : '▼';
        
        let barClass = '';
        if (g.type === 'release') barClass = 'bg-gray-700 text-white font-bold';
        else if (g.type === 'character') barClass = 'bg-gray-400 text-black font-bold gantt-group-bar-character';

        html += `
            <div class="absolute flex items-center px-2 rounded shadow ${g.type === 'character' ? 'cursor-move' : 'cursor-default'} ${barClass}"
                 style="left:${x}px; top:${taskTop}px; width:${width}px; height:${taskHeight}px; z-index:15; user-select: none;"
                 data-group-id="${g.id}">
                <span class="mr-2 text-xs cursor-pointer hover:text-blue-300 px-1" onclick="toggleGroup('${g.id}'); event.stopPropagation();">${icon}</span>
                <span class="truncate pointer-events-none" style="font-size:calc(12px * var(--ui-scale, 1));">${g.name}</span>
            </div>
        `;
    });

    // --- Render Milestones (Deadlines) ---
    // キャラクターグループごとにセクションの〆切を描画
    const charGroups = ganttConfig.groups.filter(g => g.type === 'character' && !ganttConfig.collapsedGroups.has(g.id) && !ganttConfig.collapsedGroups.has(g.parentId));
    charGroups.forEach(g => {
        const rel = getMasterItem('release', 'release_id', g.parentId);
        if (!rel) return;
        
        const artDeadline = rel.art_deadline;
        if (!artDeadline) return;

        // マイルストーン（締め切り線）はフィルターに依存せず全て表示させるため、allTasksRaw を使用する
        const charTasks = allTasksRaw.filter(t => t.release_id === g.parentId && t.char_id === g.raw.char_id);
        const activeSectionIds = new Set(charTasks.map(t => t.section_id));

        // 対象キャラクターグループの表示領域（Y座標と高さ）を計算
        // Laneは3つある想定
        const charY = groupY[g.id];
        const lanes = ganttConfig.groups.filter(child => child.type === 'lane' && child.parentId === g.id);
        if (lanes.length === 0) return;
        const groupHeight = (lanes.length + 1) * ganttConfig.rowHeight; // キャラバー + レーン
        
        // 縦線とマーカーの配置状態（重なり回避用）
        const markerPositions = {}; // key: date string, value: count
        
        masters.section.forEach(sec => {
            if (!activeSectionIds.has(sec.section_id)) return; // そのキャラクターに該当セクションのタスクが存在する場合のみ生成
            
            const filterId = document.getElementById('filter-section') ? document.getElementById('filter-section').value : '';
            if (filterId && filterId !== sec.section_id) return;

            let dateStr = artDeadline;
            let dData = deadlinesRaw.find(d => d.release_id === g.parentId && d.char_id === g.raw.char_id && d.section_id === sec.section_id);
            if (dData && dData.deadline_date) {
                dateStr = dData.deadline_date;
            }
            
            if (!markerPositions[dateStr]) markerPositions[dateStr] = 0;
            const staggerLevel = markerPositions[dateStr]++;
            
            const x = dateToX(moment(dateStr));
            const color = sec.color || '#ff0000';
            
            // 縦線 (レーン部分を貫く)
            html += `
                <div class="absolute gantt-deadline-line" data-section-id="${sec.section_id}" data-date="${dateStr}"
                     style="left:${x}px; top:${charY + ganttConfig.rowHeight}px; width:4px; height:${groupHeight - ganttConfig.rowHeight}px; background-color:${color}; opacity: 0.6; z-index: 10;"></div>
            `;
            
            // ▼マーカー（ドラッグ可能）
            // キャラクターバーの真下の行（Lane 1）の上部に配置。スタッガーして重なりを回避
            const markerTop = charY + ganttConfig.rowHeight + (staggerLevel * 14 * ganttConfig.uiScale);
            
            html += `
                <div class="absolute gantt-deadline-marker cursor-pointer flex flex-col items-center justify-center select-none"
                     data-release-id="${g.parentId}" data-char-id="${g.raw.char_id}" data-section-id="${sec.section_id}" data-date="${dateStr}"
                     style="left:${x - 6}px; top:${markerTop}px; width:16px; height:16px; z-index:25; color:${color}; font-size:16px; text-shadow: 1px 1px 0 #fff, -1px -1px 0 #fff, 1px -1px 0 #fff, -1px 1px 0 #fff;">
                    ▼
                </div>
            `;
        });
    });

    els.ganttTasks.innerHTML = html;
}

function renderDependencyLines() {
    const svg = els.ganttDependencyLines;
    if (!svg) return;
    
    // SVG内部をクリア
    svg.innerHTML = '';
    
    // 矢印マーカー（Defs）の追加
    let defs = svg.querySelector('defs');
    if (!defs) {
        defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
        defs.innerHTML = `
            <marker id="arrow" viewBox="0 0 10 10" refX="6" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                <path d="M 0 1.5 L 10 5 L 0 8.5 z" fill="#3b82f6" />
            </marker>
        `;
        svg.appendChild(defs);
    }

    // タスク要素の位置をマッピング
    const taskItems = document.querySelectorAll('.gantt-task-item');
    const taskCoords = {};
    taskItems.forEach(el => {
        const id = el.getAttribute('data-task-id');
        const rect = {
            left: parseFloat(el.style.left) || 0,
            top: parseFloat(el.style.top) || 0,
            width: parseFloat(el.style.width) || 0,
            height: parseFloat(el.style.height) || 0
        };
        taskCoords[id] = {
            left: { x: rect.left, y: rect.top + rect.height / 2 },
            right: { x: rect.left + rect.width, y: rect.top + rect.height / 2 }
        };
    });

    // 既存の依存関係線を描画
    currentFilteredTasks.forEach(t => {
        if (!t.dependencies) return;
        const depIds = t.dependencies.split(/[,;]/).map(s => s.trim()).filter(s => s);
        depIds.forEach(depId => {
            const fromCoord = taskCoords[depId];
            const toCoord = taskCoords[t.task_id];
            if (fromCoord && toCoord) {
                // 先行タスクの右端 -> 後続タスクの左端
                drawDependencyPath(svg, fromCoord.right, toCoord.left, depId, t.task_id);
            }
        });
    });

    // ドラッグ中のプレビュー線を描画
    if (dependencyDragSourceId && dependencyDragCurrentPos) {
        const fromCoord = taskCoords[dependencyDragSourceId];
        if (fromCoord) {
            drawDependencyPath(svg, fromCoord.right, dependencyDragCurrentPos, dependencyDragSourceId, null, true);
        }
    }
}

function drawDependencyPath(svg, p1, p2, fromId, toId, isPreview = false) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    
    // コントロールポイントの計算（なだらかなベジェ曲線）
    const dx = Math.abs(p2.x - p1.x);
    const cx1 = p1.x + Math.min(dx * 0.4, 40);
    const cy1 = p1.y;
    const cx2 = p2.x - Math.min(dx * 0.4, 40);
    const cy2 = p2.y;
    
    const d = `M ${p1.x} ${p1.y} C ${cx1} ${cy1}, ${cx2} ${cy2}, ${p2.x} ${p2.y}`;
    
    path.setAttribute("d", d);
    if (isPreview) {
        path.setAttribute("stroke", "#ef4444"); // ドラッグ中は赤色破線
        path.setAttribute("stroke-width", "2");
        path.setAttribute("stroke-dasharray", "4,4");
    } else {
        path.setAttribute("stroke", "#3b82f6"); // 通常は青色
        path.setAttribute("stroke-width", "2");
    }
    path.setAttribute("fill", "none");
    path.setAttribute("marker-end", "url(#arrow)");
    
    if (!isPreview) {
        path.setAttribute("class", "gantt-dependency-line pointer-events-auto cursor-pointer hover:stroke-red-500 hover:stroke-[3px] transition-colors duration-150");
        path.setAttribute("data-from", fromId);
        path.setAttribute("data-to", toId);
        
        path.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
            showDependencyLineContextMenu(e, fromId, toId);
        });
    }
    
    svg.appendChild(path);
}

function renderProgressLine() {
    const container = els.ganttProgressLine;
    if (!container) return;
    container.innerHTML = '';
    
    if (!els.toggleProgressLine || !els.toggleProgressLine.checked) return;

    const todayX = dateToX(moment().startOf('day'));
    const ganttHeight = els.ganttBodyContent.offsetHeight || 5000;

    const svgNS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(svgNS, 'svg');
    svg.style.width = '100%';
    svg.style.height = `${ganttHeight}px`;
    svg.style.position = 'absolute';
    svg.style.top = '0';
    svg.style.left = '0';
    svg.style.pointerEvents = 'none';

    const baseLine = document.createElementNS(svgNS, 'line');
    baseLine.setAttribute('x1', todayX);
    baseLine.setAttribute('y1', 0);
    baseLine.setAttribute('x2', todayX);
    baseLine.setAttribute('y2', ganttHeight);
    baseLine.setAttribute('stroke', '#9ca3af'); // 基準線をグレー系に変更
    baseLine.setAttribute('stroke-width', '1.5');
    baseLine.setAttribute('stroke-dasharray', '4 4');
    svg.appendChild(baseLine);

    const taskElements = document.querySelectorAll('.gantt-task-item');
    const tasksData = [];

    taskElements.forEach(el => {
        const taskId = el.getAttribute('data-task-id');
        const t = currentFilteredTasks.find(x => x.task_id === taskId);
        if (!t) return;
        
        const top = parseFloat(el.style.top);
        const height = parseFloat(el.style.height);
        const left = parseFloat(el.style.left);
        const width = parseFloat(el.style.width);
        
        const centerY = top + (height / 2);
        const progress = parseInt(t.progress) || 0;
        
        const progX = left + (width * (progress / 100));
        
        tasksData.push({
            id: taskId,
            y: centerY,
            progX: progX
        });
    });

    tasksData.sort((a, b) => a.y - b.y);

    if (tasksData.length > 0) {
        const yGroups = {};
        tasksData.forEach(t => {
            const yKey = Math.round(t.y);
            if (!yGroups[yKey]) yGroups[yKey] = [];
            yGroups[yKey].push(t);
        });

        const sortedYKeys = Object.keys(yGroups).map(Number).sort((a, b) => a - b);
        
        // 直線を引くヘルパー関数
        const drawLine = (x1, y1, x2, y2, color, isDash) => {
            const line = document.createElementNS(svgNS, 'line');
            line.setAttribute('x1', x1);
            line.setAttribute('y1', y1);
            line.setAttribute('x2', x2);
            line.setAttribute('y2', y2);
            line.setAttribute('stroke', color);
            line.setAttribute('stroke-width', '2');
            if (isDash) {
                line.setAttribute('stroke-dasharray', '5 5');
            }
            svg.appendChild(line);
        };
        
        let prevY = 0;
        
        sortedYKeys.forEach((yKey, index) => {
            const group = yGroups[yKey];
            const minProgX = Math.min(...group.map(t => t.progX));
            const y = yKey;
            
            // 遅延量（日数）の計算
            const diffX = Math.abs(todayX - minProgX);
            const diffDays = diffX / ganttConfig.dayWidth;
            
            // 日数に応じてアルファ値（濃さ）を計算。最大14日で上限1.0、下限は0.3
            let alpha = 0.3 + (diffDays / 14) * 0.7;
            if (alpha > 1.0) alpha = 1.0;
            
            // 色の決定 (遅延=赤、順調/正常=青)
            const color = minProgX < todayX ? `rgba(239, 68, 68, ${alpha})` : `rgba(59, 130, 246, ${alpha})`;
            
            // 7日（1週間）未満の差分なら破線とする
            const isDash = diffDays < 7;
            
            // 基準線からタスクへの進入線
            if (index === 0) {
                drawLine(todayX, 0, minProgX, y, color, isDash);
            } else {
                const midY = prevY + (y - prevY) / 2;
                drawLine(todayX, midY, minProgX, y, color, isDash);
            }
            
            // タスクから基準線への退出線
            if (index === sortedYKeys.length - 1) {
                drawLine(minProgX, y, todayX, ganttHeight, color, isDash);
            } else {
                const nextY = sortedYKeys[index + 1];
                const nextMidY = y + (nextY - y) / 2;
                drawLine(minProgX, y, todayX, nextMidY, color, isDash);
            }
            
            prevY = y;
        });
    }

    container.appendChild(svg);
}

// --- Mouse Events & Dragging ---
let panState = {
    isPanning: false,
    startX: 0,
    startY: 0,
    scrollLeft: 0,
    scrollTop: 0
};

let dragState = {
    isDragging: false,
    mode: null,
    taskId: null,
    startX: 0,
    startY: 0,
    initialLeft: 0,
    initialTop: 0,
    initialWidth: 0,
    element: null,
    originalTaskData: null
};

function setupMouseTracking() {
    let taskTooltip = document.getElementById('task-detail-tooltip');
    if (!taskTooltip) {
        taskTooltip = document.createElement('div');
        taskTooltip.id = 'task-detail-tooltip';
        taskTooltip.className = 'fixed bg-white border border-gray-300 rounded shadow-xl pointer-events-none z-[10000] text-sm hidden w-64';
        taskTooltip.innerHTML = `
            <div id="task-detail-header" class="px-3 py-2 font-bold border-b bg-gray-100 text-gray-800"></div>
            <div id="task-detail-body" class="p-3 space-y-1 text-gray-600"></div>
        `;
        document.body.appendChild(taskTooltip);
    }
    els.taskTooltip = taskTooltip;

    els.ganttBody.addEventListener('mousedown', (e) => {
        if (e.target.closest('.gantt-task-item') || e.target.closest('.gantt-resize-handle') || e.target.closest('.gantt-deadline-marker')) return;
        if (e.button !== 0) return;
        
        if (e.shiftKey || e.ctrlKey || e.metaKey) {
            const rect = els.ganttBodyContent.getBoundingClientRect();
            const startX = e.clientX - rect.left;
            const startY = e.clientY - rect.top;
            
            dragState.isDragging = true;
            dragState.mode = 'select-rect';
            dragState.startX = e.clientX;
            dragState.startY = e.clientY;
            dragState.selectRectStart = { x: startX, y: startY };
            
            let selRect = document.getElementById('gantt-selection-rect');
            if (!selRect) {
                selRect = document.createElement('div');
                selRect.id = 'gantt-selection-rect';
                selRect.style.position = 'absolute';
                selRect.style.border = '1px dashed #3b82f6';
                selRect.style.backgroundColor = 'rgba(59, 130, 246, 0.15)';
                selRect.style.pointerEvents = 'none';
                selRect.style.zIndex = '1000';
                els.ganttBodyContent.appendChild(selRect);
            }
            selRect.style.left = `${startX}px`;
            selRect.style.top = `${startY}px`;
            selRect.style.width = '0px';
            selRect.style.height = '0px';
            selRect.style.display = 'block';
            
            if (!e.ctrlKey && !e.metaKey) {
                selectedTaskIds.clear();
                document.querySelectorAll('.gantt-task-item').forEach(el => el.classList.remove('selected'));
            }
            document.body.classList.add('select-none');
            return;
        }
        
        panState.isPanning = true;
        panState.startX = e.clientX;
        panState.startY = e.clientY;
        panState.scrollLeft = els.ganttBody.scrollLeft;
        panState.scrollTop = els.ganttBody.scrollTop;
        document.body.style.cursor = 'grabbing';
    });

    els.ganttBody.addEventListener('mousemove', (e) => {
        if (dragState.isDragging || panState.isPanning) return;
        
        const rect = els.ganttBodyContent.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;
        
        if (mouseX < 0 || mouseY < 0) {
            els.crosshairCol.classList.add('hidden');
            els.crosshairRow.classList.add('hidden');
            if (els.taskTooltip) els.taskTooltip.classList.add('hidden');
            return;
        }

        const dateM = xToDate(mouseX);
        const dayLeftX = dateToX(dateM);
        
        els.crosshairCol.style.left = `${dayLeftX}px`;
        els.crosshairCol.style.width = `${ganttConfig.dayWidth}px`;
        els.crosshairCol.classList.remove('hidden');
        
        const rowIndex = Math.floor(mouseY / ganttConfig.rowHeight);
        const rowTop = rowIndex * ganttConfig.rowHeight;
        
        // グループがない場所でもクロスヘアの行は表示する
        els.crosshairRow.style.top = `${rowTop}px`;
        els.crosshairRow.style.height = `${ganttConfig.rowHeight}px`;
        els.crosshairRow.classList.remove('hidden');

        if (rowIndex >= 0 && rowIndex < ganttConfig.groups.length) {
            currentHoverGroup = ganttConfig.groups[rowIndex].id;
        } else {
            currentHoverGroup = null;
        }
        
        currentHoverDate = dateM.toDate();

        const hoveredTask = e.target.closest('.gantt-task-item');
        const hoveredMarker = e.target.closest('.gantt-deadline-marker');
        const hoveredLine = e.target.closest('.gantt-deadline-line');
        
        if (hoveredTask && els.taskTooltip) {
            const taskId = hoveredTask.getAttribute('data-task-id');
            const t = allTasksRaw.find(x => x.task_id === taskId);
            if (t) {
                const section = getMasterItem('section', 'section_id', t.section_id);
                const member = getMasterItem('member', 'member_id', t.member_id);
                const status = getMasterItem('status', 'status_id', t.status_id);
                const secName = section ? section.section_name : '未定';
                const memName = member ? member.member_name : '未定';
                const statName = status ? status.status_name : '未着手';
                const statColor = status ? status.color : '#9ca3af';
                
                let bizDays = 0;
                const startM = moment(t.start_date).startOf('day');
                const endM = moment(t.end_date).startOf('day');
                for (let m = startM.clone(); m.isSameOrBefore(endM); m.add(1, 'days')) {
                    const dStr = m.format('YYYY-MM-DD');
                    const dayOfWeek = m.day();
                    const masterHoliday = masters.holiday ? masters.holiday.find(h => h.holiday_date === dStr) : null;
                    if (masterHoliday || dayOfWeek === 0 || dayOfWeek === 6) continue;
                    bizDays++;
                }
                
                document.getElementById('task-detail-header').innerText = t.task_name;
                document.getElementById('task-detail-body').innerHTML = `
                    <div>セクション: ${secName}</div>
                    <div>担当者: ${memName}</div>
                    <div class="flex items-center gap-1">ステータス: <span class="px-1.5 py-0.5 rounded text-white text-[10px] font-bold" style="background-color:${statColor};">${statName}</span></div>
                    <div>期間: ${t.start_date} 〜 ${t.end_date}</div>
                    <div>予定工数: ${bizDays} 営業日</div>
                    <div>進捗: ${t.progress || 0}%</div>
                `;
                els.taskTooltip.style.left = `${e.clientX + 15}px`;
                els.taskTooltip.style.top = `${e.clientY + 15}px`;
                els.taskTooltip.classList.remove('hidden');
            }
        } else if ((hoveredMarker || hoveredLine) && els.taskTooltip) {
            const el = hoveredMarker || hoveredLine;
            const secId = el.getAttribute('data-section-id');
            const dateStr = el.getAttribute('data-date');
            const section = getMasterItem('section', 'section_id', secId);
            const secName = section ? section.section_name : '未定';
            
            document.getElementById('task-detail-header').innerText = `${secName} 〆切`;
            document.getElementById('task-detail-body').innerHTML = `
                <div>対象セクション: ${secName}</div>
                <div>〆切日: ${dateStr}</div>
            `;
            els.taskTooltip.style.left = `${e.clientX + 15}px`;
            els.taskTooltip.style.top = `${e.clientY + 15}px`;
            els.taskTooltip.classList.remove('hidden');
        } else {
            if (els.taskTooltip) els.taskTooltip.classList.add('hidden');
        }
    });

    els.ganttBody.addEventListener('mouseleave', () => {
        if (dragState.isDragging || panState.isPanning) return;
        els.crosshairCol.classList.add('hidden');
        els.crosshairRow.classList.add('hidden');
        if (els.taskTooltip) els.taskTooltip.classList.add('hidden');
    });

    els.ganttTasks.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        
        const connector = e.target.closest('.gantt-dependency-connector');
        if (connector) {
            e.preventDefault();
            e.stopPropagation();
            
            const taskEl = connector.closest('.gantt-task-item');
            if (!taskEl) return;
            const taskId = taskEl.getAttribute('data-task-id');
            
            dependencyDragSourceId = taskId;
            
            const rect = els.ganttBodyContent.getBoundingClientRect();
            dependencyDragCurrentPos = {
                x: e.clientX - rect.left,
                y: e.clientY - rect.top
            };
            
            dragState.isDragging = true;
            dragState.mode = 'connect-dependency';
            dragState.startX = e.clientX;
            dragState.startY = e.clientY;
            
            document.body.style.cursor = 'crosshair';
            document.body.classList.add('select-none');
            
            renderDependencyLines();
            return;
        }

        const deadlineMarker = e.target.closest('.gantt-deadline-marker');
        if (deadlineMarker) {
            e.preventDefault(); // ネイティブドラッグを防止
            dragState.isDragging = true;
            dragState.mode = 'move-deadline';
            dragState.element = deadlineMarker;
            dragState.startX = e.clientX;
            dragState.startY = e.clientY;
            dragState.initialLeft = parseFloat(deadlineMarker.style.left) + 6; // +6 to adjust for -6px offset
            dragState.releaseId = deadlineMarker.getAttribute('data-release-id');
            dragState.charId = deadlineMarker.getAttribute('data-char-id');
            dragState.sectionId = deadlineMarker.getAttribute('data-section-id');
            
            document.body.style.cursor = 'ew-resize';
            return;
        }

        const groupBar = e.target.closest('.gantt-group-bar-character');
        if (groupBar && !e.target.closest('.cursor-pointer')) {
            e.preventDefault();
            e.stopPropagation();
            dragState.isDragging = true;
            dragState.mode = 'move-group';
            dragState.element = groupBar;
            dragState.groupId = groupBar.getAttribute('data-group-id');
            dragState.startX = e.clientX;
            dragState.startY = e.clientY;
            dragState.initialTop = parseFloat(groupBar.style.top);
            dragState.initialRowIndex = Math.floor((dragState.initialTop + (24 * ganttConfig.uiScale) / 2) / ganttConfig.rowHeight);
            
            groupBar.style.zIndex = '100';
            document.body.style.cursor = 'move';
            document.body.classList.add('select-none');
            
            // ドラッグ中のガイド線を作成
            let guide = document.getElementById('gantt-group-drag-guide');
            if (!guide) {
                guide = document.createElement('div');
                guide.id = 'gantt-group-drag-guide';
                guide.className = 'absolute w-full border-t-2 border-blue-500 z-[200] pointer-events-none hidden';
                els.ganttTasks.appendChild(guide);
            }
            dragState.guide = guide;
            return;
        }

        const handle = e.target.closest('.gantt-resize-handle');
        const taskEl = e.target.closest('.gantt-task-item');
        
        if (!taskEl) return;
        e.preventDefault(); // タスクのネイティブドラッグも防止
        
        const taskId = taskEl.getAttribute('data-task-id');
        const taskRaw = allTasksRaw.find(t => t.task_id === taskId);
        if (!taskRaw) return;
        
        // 複数選択の処理
        if (e.ctrlKey || e.metaKey) {
            if (selectedTaskIds.has(taskId)) {
                selectedTaskIds.delete(taskId);
                taskEl.classList.remove('selected');
                return; // ドラッグ開始しない
            } else {
                selectedTaskIds.add(taskId);
                taskEl.classList.add('selected');
            }
        } else {
            if (!selectedTaskIds.has(taskId)) {
                selectedTaskIds.clear();
                document.querySelectorAll('.gantt-task-item').forEach(el => el.classList.remove('selected'));
                selectedTaskIds.add(taskId);
                taskEl.classList.add('selected');
            }
        }

        dragState.isDragging = true;
        dragState.taskId = taskId;
        dragState.element = taskEl;
        dragState.originalTaskData = JSON.parse(JSON.stringify(taskRaw));
        
        dragState.startX = e.clientX;
        dragState.startY = e.clientY;
        dragState.initialLeft = parseFloat(taskEl.style.left);
        dragState.initialTop = parseFloat(taskEl.style.top);
        dragState.initialWidth = parseFloat(taskEl.style.width);
        
        dragState.selectedTasks = Array.from(selectedTaskIds).map(id => {
            const el = document.querySelector(`.gantt-task-item[data-task-id="${id}"]`);
            return {
                id: id,
                element: el,
                initialLeft: el ? parseFloat(el.style.left) : 0,
                initialTop: el ? parseFloat(el.style.top) : 0,
                initialWidth: el ? parseFloat(el.style.width) : 0
            };
        }).filter(t => t.element);
        
        if (handle) {
            dragState.mode = handle.getAttribute('data-action');
        } else {
            dragState.mode = 'move';
        }
        
        dragState.selectedTasks.forEach(st => {
            st.element.style.zIndex = '100';
        });
        document.body.style.cursor = dragState.mode === 'move' ? 'move' : 'ew-resize';
        document.body.classList.add('select-none');
        
        els.crosshairCol.classList.add('hidden');
        els.crosshairRow.classList.add('hidden');
        if(els.taskTooltip) els.taskTooltip.classList.add('hidden');
    });

    document.addEventListener('mousemove', (e) => {
        if (panState.isPanning) {
            const dx = e.clientX - panState.startX;
            const dy = e.clientY - panState.startY;
            els.ganttBody.scrollLeft = panState.scrollLeft - dx;
            els.ganttBody.scrollTop = panState.scrollTop - dy;
            return;
        }

        if (!dragState.isDragging) return;

        if (dragState.mode === 'select-rect') {
            const rect = els.ganttBodyContent.getBoundingClientRect();
            const curX = e.clientX - rect.left;
            const curY = e.clientY - rect.top;
            
            const startX = dragState.selectRectStart.x;
            const startY = dragState.selectRectStart.y;
            
            const left = Math.min(startX, curX);
            const top = Math.min(startY, curY);
            const width = Math.abs(startX - curX);
            const height = Math.abs(startY - curY);
            
            const selRect = document.getElementById('gantt-selection-rect');
            if (selRect) {
                selRect.style.left = `${left}px`;
                selRect.style.top = `${top}px`;
                selRect.style.width = `${width}px`;
                selRect.style.height = `${height}px`;
            }
            
            const taskItems = document.querySelectorAll('.gantt-task-item');
            taskItems.forEach(el => {
                const id = el.getAttribute('data-task-id');
                const tLeft = parseFloat(el.style.left) || 0;
                const tTop = parseFloat(el.style.top) || 0;
                const tWidth = parseFloat(el.style.width) || 0;
                const tHeight = parseFloat(el.style.height) || 0;
                
                const intersect = (left < tLeft + tWidth && left + width > tLeft &&
                                   top < tTop + tHeight && top + height > tTop);
                                  
                if (intersect) {
                    selectedTaskIds.add(id);
                    el.classList.add('selected');
                } else {
                    if (!e.ctrlKey && !e.metaKey && !e.shiftKey) {
                        selectedTaskIds.delete(id);
                        el.classList.remove('selected');
                    }
                }
            });
            return;
        }
        
        const dx = e.clientX - dragState.startX;
        const dy = e.clientY - dragState.startY;
        
        if (dragState.mode === 'move') {
            const movingIds = new Set(dragState.selectedTasks.map(st => st.id));
            dragState.selectedTasks.forEach(st => {
                const rawLeft = st.initialLeft + dx;
                const rawTop = st.initialTop + dy;
                let snappedLeft = Math.round(rawLeft / ganttConfig.dayWidth) * ganttConfig.dayWidth;
                
                const minStartLimit = getMinStartLimit(st.id, movingIds);
                if (minStartLimit) {
                    const minStartX = dateToX(minStartLimit.clone().add(1, 'days'));
                    if (snappedLeft < minStartX) {
                        snappedLeft = minStartX;
                    }
                }
                
                st.element.style.left = `${snappedLeft}px`;
                st.element.style.top = `${rawTop}px`;
            });
        } else if (dragState.mode === 'move-group') {
            const rawTop = dragState.initialTop + dy;
            dragState.element.style.top = `${rawTop}px`;
            
            const centerTop = rawTop + (24 * ganttConfig.uiScale) / 2;
            const rowIndex = Math.floor(centerTop / ganttConfig.rowHeight);
            
            if (rowIndex >= 0 && rowIndex < ganttConfig.groups.length) {
                const hoverGroup = ganttConfig.groups[rowIndex];
                if (hoverGroup) {
                    dragState.guide.style.top = `${rowIndex * ganttConfig.rowHeight}px`;
                    dragState.guide.classList.remove('hidden');
                    dragState.targetRowIndex = rowIndex;
                }
            }
        } else if (dragState.mode === 'move-deadline') {
            const rawLeft = dragState.initialLeft + dx;
            const snappedLeft = Math.round(rawLeft / ganttConfig.dayWidth) * ganttConfig.dayWidth;
            dragState.element.style.left = `${snappedLeft - 6}px`; // adjust offset back
        } else if (dragState.mode === 'resize-right') {
            const rawWidth = dragState.initialWidth + dx;
            const snappedWidth = Math.max(ganttConfig.dayWidth, Math.round(rawWidth / ganttConfig.dayWidth) * ganttConfig.dayWidth);
            dragState.element.style.width = `${snappedWidth}px`;
        } else if (dragState.mode === 'resize-left') {
            const rawLeft = dragState.initialLeft + dx;
            let snappedLeft = Math.round(rawLeft / ganttConfig.dayWidth) * ganttConfig.dayWidth;
            
            const minStartLimit = getMinStartLimit(dragState.taskId);
            if (minStartLimit) {
                const minStartX = dateToX(minStartLimit.clone().add(1, 'days'));
                if (snappedLeft < minStartX) {
                    snappedLeft = minStartX;
                }
            }
            
            const rightEdge = dragState.initialLeft + dragState.initialWidth;
            const snappedWidth = Math.max(ganttConfig.dayWidth, rightEdge - snappedLeft);
            const actualLeft = rightEdge - snappedWidth;
            dragState.element.style.width = `${snappedWidth}px`;
            dragState.element.style.left = `${actualLeft}px`;
        } else if (dragState.mode === 'connect-dependency') {
            const rect = els.ganttBodyContent.getBoundingClientRect();
            dependencyDragCurrentPos = {
                x: e.clientX - rect.left,
                y: e.clientY - rect.top
            };
            
            const hoverTarget = findDependencyTarget(e.clientX, e.clientY);
            
            document.querySelectorAll('.gantt-task-item').forEach(el => {
                el.classList.remove('dependency-target-hover');
            });
            if (hoverTarget && hoverTarget !== dependencyDragSourceId) {
                const targetEl = document.querySelector(`.gantt-task-item[data-task-id="${hoverTarget}"]`);
                if (targetEl) targetEl.classList.add('dependency-target-hover');
            }
            
            renderDependencyLines();
        }
    });

    document.addEventListener('mouseup', (e) => {
        if (panState.isPanning) {
            panState.isPanning = false;
            document.body.style.cursor = '';
            return;
        }

        if (!dragState.isDragging) return;

        if (dragState.mode === 'select-rect') {
            const selRect = document.getElementById('gantt-selection-rect');
            if (selRect) {
                selRect.style.display = 'none';
            }
            dragState.isDragging = false;
            document.body.classList.remove('select-none');
            return;
        }

        if (dragState.mode === 'connect-dependency') {
            const targetId = findDependencyTarget(e.clientX, e.clientY);
            
            document.querySelectorAll('.gantt-task-item').forEach(el => {
                el.classList.remove('dependency-target-hover');
            });
            
            if (targetId && targetId !== dependencyDragSourceId) {
                addDependency(dependencyDragSourceId, targetId);
            }
            
            dependencyDragSourceId = null;
            dependencyDragCurrentPos = null;
            dragState.isDragging = false;
            document.body.style.cursor = '';
            document.body.classList.remove('select-none');
            renderDependencyLines();
            return;
        }
        
        try {
            const dx = Math.abs(e.clientX - dragState.startX);
            const dy = Math.abs(e.clientY - dragState.startY);
            const isClick = (dx < 3 && dy < 3);

            if (isClick) {
                if (!e.ctrlKey && !e.metaKey && dragState.taskId) {
                    selectedTaskIds.clear();
                    document.querySelectorAll('.gantt-task-item').forEach(el => el.classList.remove('selected'));
                    selectedTaskIds.add(dragState.taskId);
                    if (dragState.element && dragState.element.classList.contains('gantt-task-item')) {
                        dragState.element.classList.add('selected');
                    }
                }
                currentTaskContextId = dragState.taskId;
                
                dragState.isDragging = false;
                dragState.element = null;
                dragState.taskId = null;
                document.body.style.cursor = '';
                document.body.classList.remove('select-none');
                return;
            }
    
            document.body.style.cursor = '';
            document.body.classList.remove('select-none');
            
            if (dragState.mode === 'move-deadline') {
                const finalLeft = parseFloat(dragState.element.style.left) + 6;
                const newDateM = xToDate(finalLeft).startOf('day');
                const dateStr = newDateM.format('YYYY-MM-DD');
            
            // 既存のデータを検索または追加
            let dData = deadlinesRaw.find(d => d.release_id === dragState.releaseId && d.char_id === dragState.charId && d.section_id === dragState.sectionId);
            if (!dData) {
                dData = {
                    release_id: dragState.releaseId,
                    char_id: dragState.charId,
                    section_id: dragState.sectionId,
                    deadline_date: dateStr
                };
                deadlinesRaw.push(dData);
            } else {
                dData.deadline_date = dateStr;
            }
            
            markUnsaved();
            renderGantt();
            
            dragState.isDragging = false;
            dragState.element = null;
            return;
        }
        
            if (dragState.mode === 'move-group') {
                if (dragState.guide) {
                    dragState.guide.classList.add('hidden');
                }
                
                if (dragState.targetRowIndex !== undefined) {
                    const targetGroup = ganttConfig.groups[dragState.targetRowIndex];
                    const draggedGroup = ganttConfig.groups.find(g => g.id === dragState.groupId);
                    
                    if (draggedGroup && targetGroup && targetGroup.id !== draggedGroup.id) {
                        let targetRelId, targetCharId;
                        
                        if (targetGroup.type === 'character') {
                            targetRelId = targetGroup.parentId;
                            targetCharId = targetGroup.raw.char_id;
                        } else if (targetGroup.type === 'lane') {
                            const parentCharGroup = ganttConfig.groups.find(g => g.id === targetGroup.parentId);
                            if (parentCharGroup) {
                                targetRelId = parentCharGroup.parentId;
                                targetCharId = parentCharGroup.raw.char_id;
                            }
                        }
                        
                        const draggedRelId = draggedGroup.parentId;
                        const draggedCharId = draggedGroup.raw.char_id;
                        
                        if (targetRelId === draggedRelId && targetCharId && targetCharId !== draggedCharId) {
                            saveHistory();
                            
                            // ガントに表示されているキャラクターの順序を取得
                            const charGroups = ganttConfig.groups.filter(g => g.type === 'character' && g.parentId === targetRelId);
                            const charIds = charGroups.map(g => g.raw.char_id);
                            
                            const fromIdx = charIds.indexOf(draggedCharId);
                            let toIdx = charIds.indexOf(targetCharId);
                            
                            if (fromIdx !== -1 && toIdx !== -1) {
                                // ドラッグ方向に応じて挿入位置を調整
                                if (dragState.initialRowIndex < dragState.targetRowIndex) {
                                    toIdx = toIdx + 1;
                                }
                                
                                charIds.splice(fromIdx, 1);
                                if (fromIdx < toIdx) {
                                    toIdx--;
                                }
                                charIds.splice(toIdx, 0, draggedCharId);
                                
                                // 新しいキャラ順序に基づいて allTasksRaw を再構築
                                const newTasks = [];
                                const targetReleaseTasks = allTasksRaw.filter(t => t.release_id === targetRelId);
                                const otherTasks = allTasksRaw.filter(t => t.release_id !== targetRelId);
                                
                                charIds.forEach(cid => {
                                    const tasksForChar = targetReleaseTasks.filter(t => t.char_id === cid);
                                    newTasks.push(...tasksForChar);
                                });
                                
                                const noCharTasks = targetReleaseTasks.filter(t => !charIds.includes(t.char_id));
                                newTasks.push(...noCharTasks);
                                
                                const firstTargetIdx = allTasksRaw.findIndex(t => t.release_id === targetRelId);
                                if (firstTargetIdx !== -1) {
                                    const before = allTasksRaw.slice(0, firstTargetIdx).filter(t => t.release_id !== targetRelId);
                                    const after = allTasksRaw.slice(firstTargetIdx).filter(t => t.release_id !== targetRelId);
                                    allTasksRaw = [...before, ...newTasks, ...after];
                                } else {
                                    allTasksRaw = [...otherTasks, ...newTasks];
                                }
                            }
                            
                            markUnsaved();
                            renderGantt();
                        } else {
                            renderGantt();
                        }
                    } else {
                        renderGantt();
                    }
                } else {
                    renderGantt();
                }
                
                dragState.isDragging = false;
                dragState.element = null;
                dragState.targetRowIndex = undefined;
                return;
            }

            if (dragState.selectedTasks && dragState.selectedTasks.length > 0) {
                saveHistory();
                
                dragState.selectedTasks.forEach(st => {
                    const raw = allTasksRaw.find(t => t.task_id === st.id);
                    if (!raw) return;
                    
                    const finalLeft = parseFloat(st.element.style.left);
                    const finalWidth = parseFloat(st.element.style.width);
                    const finalTop = parseFloat(st.element.style.top);
                    
                    const newStartM = xToDate(finalLeft).startOf('day');
                    const newEndM = xToDate(finalLeft + finalWidth).subtract(1, 'milliseconds').startOf('day');
                    
                    raw.start_date = newStartM.format('YYYY-MM-DD');
                    raw.end_date = newEndM.format('YYYY-MM-DD');
                    
                    if (dragState.mode === 'move') {
                        const centerTop = finalTop + (24 * ganttConfig.uiScale) / 2;
                        const rowIndex = Math.floor(centerTop / ganttConfig.rowHeight);
                        if (rowIndex >= 0 && rowIndex < ganttConfig.groups.length) {
                            const targetGroup = ganttConfig.groups[rowIndex];
                            if (targetGroup.type === 'lane') {
                                const parts = targetGroup.id.split('_');
                                if (parts.length >= 4) {
                                    raw.release_id = parts[0] + '_' + parts[1];
                                    raw.char_id = parts[2] + '_' + parts[3];
                                    raw.lane = parts[4] ? parts[4].replace('LANE', '') : '1';
                                }
                            }
                        }
                    }
                });
                
                // ドラッグ移動/リサイズ完了後に、再帰的に後続タスクを押し出す
                dragState.selectedTasks.forEach(st => {
                    pushSuccessorsRecursive(st.id);
                });
                
                markUnsaved();
                renderGantt();
            }
        } catch (e) {
            console.error(e);
        } finally {
            if (dragState.guide) dragState.guide.classList.add('hidden');
            dragState.isDragging = false;
            dragState.element = null;
            dragState.taskId = null;
            dragState.selectedTasks = null;
            dragState.targetRowIndex = undefined;
            document.body.style.cursor = '';
            document.body.classList.remove('select-none');
        }
    });
}

function setupZoom() {
    document.getElementById('gantt-container').addEventListener('wheel', (e) => {
        if (e.target.closest('#side-panel') || e.target.closest('#context-menu')) return;
        
        e.preventDefault();
        e.stopPropagation();
        
        if (e.ctrlKey) {
            if (e.deltaY < 0) ganttConfig.uiScale = Math.min(ganttConfig.uiScale + 0.1, 2.0);
            else ganttConfig.uiScale = Math.max(ganttConfig.uiScale - 0.1, 0.5);
            
            ganttConfig.rowHeight = 36 * ganttConfig.uiScale;
            document.documentElement.style.setProperty('--ui-scale', ganttConfig.uiScale);
            renderGantt();
        } else {
            const zoomFactor = e.deltaY < 0 ? 1.2 : 0.8;
            
            // ズーム前の「マウスが指している日付」を記憶
            const mouseXInContainer = e.clientX - els.ganttBody.getBoundingClientRect().left;
            const scrollLeftBefore = els.ganttBody.scrollLeft;
            const absoluteMouseX = scrollLeftBefore + mouseXInContainer;
            const dateAtMouse = xToDate(absoluteMouseX);
            
            ganttConfig.dayWidth = Math.max(5, Math.min(200, ganttConfig.dayWidth * zoomFactor));
            renderGantt();
            
            // ズーム後も、先ほどと同じ日付が「同じ画面上のX座標」に来るようにスクロール調整
            const newAbsoluteMouseX = dateToX(dateAtMouse);
            els.ganttBody.scrollLeft = newAbsoluteMouseX - mouseXInContainer;
        }
    }, { passive: false, capture: true });
}

// --- Editor & Context Menu ---
function setEditorVisibility(type) {
    const fields = ['release', 'event', 'character', 'section', 'task-name', 'member', 'dates', 'progress'];
    fields.forEach(f => {
        const el = document.getElementById(`editor-field-${f}`);
        if (el) el.classList.remove('hidden');
    });

    if (type === 'release') {
        ['character', 'section', 'task-name', 'member', 'dates', 'progress'].forEach(f => {
            const el = document.getElementById(`editor-field-${f}`);
            if (el) el.classList.add('hidden');
        });
        document.getElementById('edit-release').disabled = true;
    } else if (type === 'character') {
        ['section', 'task-name', 'member', 'dates', 'progress'].forEach(f => {
            const el = document.getElementById(`editor-field-${f}`);
            if (el) el.classList.add('hidden');
        });
        document.getElementById('edit-release').disabled = true;
        document.getElementById('edit-character').disabled = true;
    } else {
        document.getElementById('edit-release').disabled = false;
        document.getElementById('edit-character').disabled = false;
    }
}

function updateEventDisplay(releaseId) {
    const el = document.getElementById('edit-event');
    if (!el) return;
    if (releaseId) {
        const rel = getMasterItem('release', 'release_id', releaseId);
        el.value = rel ? rel.event_name : '';
    } else {
        el.value = '';
    }
}

function validateTaskEditor() {
    const type = document.getElementById('edit-group-type').value;
    const btnApply = document.getElementById('btn-apply-task');
    if (type !== 'task') {
        btnApply.disabled = false;
        return;
    }

    const rel = document.getElementById('edit-release').value;
    const char = document.getElementById('edit-character').value;
    const sec = document.getElementById('edit-section').value;
    const taskName = document.getElementById('edit-task-name').value;
    const start = document.getElementById('edit-start').value;
    const end = document.getElementById('edit-end').value;

    if (!rel || !char || !sec || !taskName || !start || !end) {
        btnApply.disabled = true;
    } else {
        btnApply.disabled = false;
    }
}

function openEditor(data, type = 'task') {
    populateDropdowns();
    document.getElementById('edit-group-type').value = type;

    if (type === 'task') {
        setEditorVisibility('task');
        const raw = allTasksRaw.find(t => t.task_id === data);
        if (!raw) return;
        
        document.getElementById('edit-task-id').value = raw.task_id;
        document.getElementById('edit-release').value = raw.release_id;
        document.getElementById('edit-character').value = raw.char_id;
        document.getElementById('edit-section').value = raw.section_id;
        
        updateEventDisplay(raw.release_id);
        
        document.getElementById('edit-section').dispatchEvent(new Event('change'));
        
        document.getElementById('edit-task-name').value = raw.task_name;
        document.getElementById('edit-member').value = raw.member_id;
        document.getElementById('edit-start').value = raw.start_date;
        document.getElementById('edit-end').value = raw.end_date;
        document.getElementById('edit-progress').value = raw.progress;

        document.getElementById('btn-delete-task').classList.remove('hidden');
        document.getElementById('btn-apply-task').classList.remove('hidden');
        document.getElementById('editor-title').textContent = 'タスク編集';
    } else if (type === 'group') {
        const group = data; // data is group object
        document.getElementById('edit-task-id').value = '';
        
        if (group.type === 'release') {
            setEditorVisibility('release');
            document.getElementById('edit-release').value = group.raw.release_id;
            updateEventDisplay(group.raw.release_id);
            document.getElementById('editor-title').textContent = 'バージョン情報';
        } else if (group.type === 'character') {
            setEditorVisibility('character');
            document.getElementById('edit-release').value = group.parentId;
            document.getElementById('edit-character').value = group.raw.char_id;
            updateEventDisplay(group.parentId);
            document.getElementById('editor-title').textContent = 'キャラクター情報';
        }
        
        document.getElementById('btn-delete-task').classList.add('hidden');
        document.getElementById('btn-apply-task').classList.add('hidden'); // 表示のみ
    }

    document.getElementById('side-panel').classList.remove('translate-x-full');
    validateTaskEditor();
}

function openEditorNew(groupId, dateObj) {
    populateDropdowns();
    setEditorVisibility('task');
    document.getElementById('edit-group-type').value = 'task';
    document.getElementById('edit-task-id').value = '';
    
    // マウスカーソル位置（groupId）から、挿入すべき配列のインデックスを計算する
    insertTargetIndex = -1;
    if (groupId) {
        const parts = groupId.split('_');
        if (parts.length >= 2) {
            const relId = parts[0] + '_' + parts[1];
            // 同じリリースの最後のタスクを探す
            for (let i = allTasksRaw.length - 1; i >= 0; i--) {
                if (allTasksRaw[i].release_id === relId) {
                    insertTargetIndex = i + 1; // その直後に挿入
                    
                    // もし charId が取れれば、そのキャラの最後のタスクの直後にする
                    if (parts.length >= 4) {
                        const charId = parts[2] + '_' + parts[3];
                        for (let j = allTasksRaw.length - 1; j >= 0; j--) {
                            if (allTasksRaw[j].release_id === relId && allTasksRaw[j].char_id === charId) {
                                insertTargetIndex = j + 1;
                                break;
                            }
                        }
                    }
                    break;
                }
            }
        }
    }

    const dateStr = moment(dateObj).format('YYYY-MM-DD');
    document.getElementById('edit-start').value = dateStr;
    document.getElementById('edit-end').value = dateStr;
    document.getElementById('edit-progress').value = 0;
    
    document.getElementById('edit-release').value = '';
    document.getElementById('edit-character').value = '';
    updateEventDisplay('');

    if (groupId) {
        const parts = groupId.split('_');
        if (parts.length >= 4) {
            const releaseId = parts[0] + '_' + parts[1];
            document.getElementById('edit-release').value = releaseId;
            document.getElementById('edit-character').value = parts[2] + '_' + parts[3];
            updateEventDisplay(releaseId);
        }
    }
    
    document.getElementById('btn-delete-task').classList.add('hidden');
    document.getElementById('btn-apply-task').classList.remove('hidden');
    document.getElementById('editor-title').textContent = '新規タスク作成';
    document.getElementById('side-panel').classList.remove('translate-x-full');
    validateTaskEditor();
}

function syncCharacterDropdowns(charId) {
    const nameSel = document.getElementById('edit-character-name');
    const costumeSel = document.getElementById('edit-character-costume');
    const hiddenChar = document.getElementById('edit-character');
    
    hiddenChar.value = charId || '';
    if (!charId) {
        nameSel.value = '';
        costumeSel.innerHTML = '<option value="">選択してください</option>';
        return;
    }
    
    const charObj = masters.character.find(c => c.char_id === charId);
    if (charObj) {
        nameSel.value = charObj.char_name;
        const costumes = masters.character.filter(c => c.char_name === charObj.char_name);
        costumeSel.innerHTML = costumes.map(c => `<option value="${c.char_id}">${c.costume_name || 'デフォルト'}</option>`).join('');
        costumeSel.value = charId;
    } else {
        nameSel.value = '';
        costumeSel.innerHTML = '<option value="">選択してください</option>';
    }
}

function populateDropdowns() {
    const renderOptions = (data, idField, nameField, selectId) => {
        const sel = document.getElementById(selectId);
        sel.innerHTML = '<option value="">選択してください</option>' + 
            data.map(d => `<option value="${d[idField]}">${d[nameField]}</option>`).join('');
    };
    renderOptions(masters.release, 'release_id', 'release_name', 'edit-release');
    renderOptions(masters.section, 'section_id', 'section_name', 'edit-section');

    const nameSel = document.getElementById('edit-character-name');
    if (nameSel && masters.character) {
        const uniqueNames = [...new Set(masters.character.map(c => c.char_name))];
        nameSel.innerHTML = '<option value="">選択してください</option>' + 
            uniqueNames.map(n => `<option value="${n}">${n}</option>`).join('');
        document.getElementById('edit-character-costume').innerHTML = '<option value="">選択してください</option>';
    }
}

function setupMiscEvents() {
    // フォームバリデーション用のイベント登録
    const editFields = ['edit-release', 'edit-character-name', 'edit-character-costume', 'edit-section', 'edit-task-name', 'edit-member', 'edit-start', 'edit-end', 'edit-progress', 'edit-status'];
    editFields.forEach(id => {
        const el = document.getElementById(id);
        if(el) {
            el.addEventListener('change', validateTaskEditor);
            el.addEventListener('input', validateTaskEditor);
        }
    });

    document.getElementById('edit-character-name').addEventListener('change', (e) => {
        const selectedName = e.target.value;
        const costumeSel = document.getElementById('edit-character-costume');
        const hiddenChar = document.getElementById('edit-character');
        
        if (!selectedName) {
            costumeSel.innerHTML = '<option value="">選択してください</option>';
            hiddenChar.value = '';
            return;
        }
        
        const costumes = masters.character.filter(c => c.char_name === selectedName);
        costumeSel.innerHTML = costumes.map(c => `<option value="${c.char_id}">${c.costume_name || 'デフォルト'}</option>`).join('');
        hiddenChar.value = costumeSel.value;
    });

    document.getElementById('edit-character-costume').addEventListener('change', (e) => {
        document.getElementById('edit-character').value = e.target.value;
    });
    document.getElementById('btn-close-panel').addEventListener('click', () => {
        document.getElementById('side-panel').classList.add('translate-x-full');
    });

    document.getElementById('edit-release').addEventListener('change', (e) => {
        updateEventDisplay(e.target.value);
    });

    document.getElementById('edit-section').addEventListener('change', (e) => {
        const secId = e.target.value;
        const members = masters.member.filter(m => m.section_id === secId);
        const templates = masters.task_template.filter(t => t.section_id === secId);
        const selM = document.getElementById('edit-member');
        selM.innerHTML = members.map(m => `<option value="${m.member_id}">${m.member_name}${m.display_name ? ' (' + m.display_name + ')' : ''}</option>`).join('');
        const selT = document.getElementById('edit-task-name');
        selT.innerHTML = '<option value="">手入力または選択</option>' + templates.map(t => `<option value="${t.task_name}" data-days="${t.default_days}">${t.task_name}</option>`).join('');
    });

    document.getElementById('edit-task-name').addEventListener('change', (e) => {
        const selected = e.target.options[e.target.selectedIndex];
        const days = selected.getAttribute('data-days');
        if (days) {
            const start = document.getElementById('edit-start').value;
            if (start) {
                const endDate = new Date(start);
                endDate.setDate(endDate.getDate() + parseInt(days));
                document.getElementById('edit-end').value = endDate.toISOString().split('T')[0];
            }
        }
    });

    document.getElementById('btn-undo').addEventListener('click', performUndo);
    document.getElementById('btn-redo').addEventListener('click', performRedo);

    document.getElementById('btn-save').addEventListener('click', async () => {
        try {
            const res = await fetch(`/api/tasks/save?project=${currentProject}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(allTasksRaw)
            });
            
            const resDeadlines = await fetch(`/api/deadlines/save?project=${currentProject}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(deadlinesRaw)
            });
            
            // タスクの出現順に基づいてマスターデータの順序も更新する
            if (masters.character) {
                const orderedChars = [];
                const seenChars = new Set();
                
                // ガントに表示されている順序（タスク順）で取得
                allTasksRaw.forEach(t => {
                    if (t.char_id && !seenChars.has(t.char_id)) {
                        seenChars.add(t.char_id);
                        const charObj = masters.character.find(c => c.char_id === t.char_id);
                        if (charObj) {
                            orderedChars.push(charObj);
                        }
                    }
                });
                
                // タスクに含まれていないキャラクターを最後に追加
                masters.character.forEach(c => {
                    if (!seenChars.has(c.char_id)) {
                        orderedChars.push(c);
                    }
                });
                
                masters.character = orderedChars;
                
                await fetch(`/api/masters/save?project=${currentProject}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        master_type: 'character',
                        data: orderedChars
                    })
                });
            }

            const result = await res.json();
            const resultDeadlines = await resDeadlines.json();
            
            if (result.status === 'success' && resultDeadlines.status === 'success') {
                hasUnsavedChanges = false;
                els.unsavedBadge.classList.add('hidden');
                alert('保存が完了しました。');
            } else {
                alert('エラー: ' + result.message + ' / ' + resultDeadlines.message);
            }
        } catch(e) {
            alert('保存に失敗しました。');
        }
    });

    const btnRestart = document.getElementById('btn-restart');
    if (btnRestart) {
        btnRestart.addEventListener('click', async () => {
            if (confirm('サーバーを再起動して最新の状態を読み込みますか？')) {
                try {
                    await fetch('/api/restart', { method: 'POST' });
                    setTimeout(() => {
                        window.location.reload(true);
                    }, 2000);
                } catch (e) {
                    alert('再起動リクエストを送信しました。黒い画面が新しく開いたことを確認してから、ページをリロードしてください。');
                }
            }
        });
    }

    // --- AI Chat Logic ---
    const btnAiChat = document.getElementById('btn-ai-chat');
    const aiChatPanel = document.getElementById('ai-chat-panel');
    const btnCloseAiChat = document.getElementById('btn-close-ai-chat');
    const btnAiSettings = document.getElementById('btn-ai-settings');
    const aiSettingsDialog = document.getElementById('ai-settings-dialog');
    const btnSaveAiSettings = document.getElementById('btn-save-ai-settings');
    const aiProvider = document.getElementById('ai-provider');
    const aiApiKey = document.getElementById('ai-api-key');
    const aiModelSelect = document.getElementById('ai-model-select');
    const aiModelManual = document.getElementById('ai-model-manual');
    const aiTemperature = document.getElementById('ai-temperature');
    const aiTempVal = document.getElementById('ai-temp-val');
    const aiSystemPrompt = document.getElementById('ai-system-prompt');

    // --- AI Session Management ---
    let currentSessionId = null;
    let currentAiMode = 'assistant'; // 'assistant' または 'operator'
    let attachedFileContent = null;
    let attachedFileName = null;
    let attachedImages = []; // ペーストされた画像データの配列 (Base64)
    let allTasksRawBackup = null; // スケジュール提案の一時プレビュー用バックアップ

    const aiSessionsView = document.getElementById('ai-sessions-view');
    const aiChatView = document.getElementById('ai-chat-view');
    const btnBackToSessions = document.getElementById('btn-back-to-sessions');
    const aiSessionList = document.getElementById('ai-session-list');
    const aiNoSessionsMsg = document.getElementById('ai-no-sessions-msg');

    // モード切替のUIイベント登録
    const btnModeAssistant = document.getElementById('btn-mode-assistant');
    const btnModeOperator = document.getElementById('btn-mode-operator');

    function setAiMode(mode) {
        currentAiMode = mode;
        if (mode === 'assistant') {
            btnModeAssistant.className = "flex-1 py-1 px-2 rounded text-center bg-white text-blue-800 shadow-sm transition flex justify-center items-center space-x-1";
            btnModeOperator.className = "flex-1 py-1 px-2 rounded text-center text-gray-600 hover:text-gray-900 transition flex justify-center items-center space-x-1";
            document.getElementById('ai-chat-input').placeholder = "メッセージを入力... (Ctrl+Enterで送信)";
        } else {
            btnModeOperator.className = "flex-1 py-1 px-2 rounded text-center bg-white text-blue-800 shadow-sm transition flex justify-center items-center space-x-1";
            btnModeAssistant.className = "flex-1 py-1 px-2 rounded text-center text-gray-600 hover:text-gray-900 transition flex justify-center items-center space-x-1";
            document.getElementById('ai-chat-input').placeholder = "マスタ操作の指示を入力してください... (例: キャラマスタに衣装を追加して)";
        }
    }

    if (btnModeAssistant && btnModeOperator) {
        btnModeAssistant.addEventListener('click', () => setAiMode('assistant'));
        btnModeOperator.addEventListener('click', () => setAiMode('operator'));
    }

    // ファイル添付（ドラッグ＆ドロップ、クリック）の登録
    const btnAiAttach = document.getElementById('btn-ai-attach');
    const aiFileInput = document.getElementById('ai-file-input');
    const aiAttachmentBadge = document.getElementById('ai-attachment-badge');
    const aiAttachmentName = document.getElementById('ai-attachment-name');
    const btnRemoveAttachment = document.getElementById('btn-remove-attachment');
    const aiInputSection = document.getElementById('ai-input-section');

    if (btnAiAttach && aiFileInput) {
        btnAiAttach.addEventListener('click', () => {
            aiFileInput.click();
        });
        aiFileInput.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (file) handleAttachedFile(file);
        });
    }

    // ドラッグ＆ドロップの処理
    if (aiInputSection) {
        aiInputSection.addEventListener('dragover', (e) => {
            e.preventDefault();
            aiInputSection.classList.add('bg-blue-50');
        });
        aiInputSection.addEventListener('dragleave', () => {
            aiInputSection.classList.remove('bg-blue-50');
        });
        aiInputSection.addEventListener('drop', (e) => {
            e.preventDefault();
            aiInputSection.classList.remove('bg-blue-50');
            const file = e.dataTransfer.files[0];
            if (file) handleAttachedFile(file);
        });
    }

    function handleAttachedFile(file) {
        const reader = new FileReader();
        reader.onload = function(e) {
            attachedFileContent = e.target.result;
            attachedFileName = file.name;
            aiAttachmentName.textContent = `📎 ${file.name}`;
            aiAttachmentBadge.classList.remove('hidden');
        };
        // テキスト、CSVなど、とりあえずテキストとして読み込む
        reader.readAsText(file);
    }

    if (btnRemoveAttachment) {
        btnRemoveAttachment.addEventListener('click', () => {
            attachedFileContent = null;
            attachedFileName = null;
            aiAttachmentBadge.classList.add('hidden');
            aiFileInput.value = '';
        });
    }
    
    const newSessionStart = document.getElementById('ai-new-session-start');
    const newSessionEnd = document.getElementById('ai-new-session-end');
    const btnStartNewSession = document.getElementById('btn-start-new-session');
    const aiPanelTitle = document.getElementById('ai-panel-title');

    function loadAiSessions() {
        const sessions = JSON.parse(localStorage.getItem('ai_sessions') || '[]');
        aiSessionList.innerHTML = '';
        if (sessions.length === 0) {
            aiSessionList.appendChild(aiNoSessionsMsg);
            aiNoSessionsMsg.classList.remove('hidden');
        } else {
            aiNoSessionsMsg.classList.add('hidden');
            
            const settings = JSON.parse(localStorage.getItem('ai_settings') || '{}');
            const rate = settings.usdJpyRate || getUsdJpyRate();

            // 降順（新しい順）で表示
            sessions.reverse().forEach(session => {
                // セッションごとの合計コスト計算
                let totalCostUSD = session.totalCostUSD || 0;
                let totalCostJPY = session.totalCostJPY || 0;
                let hasUnregisteredModel = false;
                
                if (session.messages) {
                    session.messages.forEach(m => {
                        if (m.role === 'assistant' && m.tokens) {
                            const cost = calculateCost(m.model || settings.model, m.tokens, m.input_tokens, m.output_tokens, rate);
                            if (cost) {
                                if (!session.totalCostUSD) {
                                    totalCostUSD += cost.usd;
                                    totalCostJPY += cost.jpy;
                                }
                            } else {
                                hasUnregisteredModel = true;
                            }
                        }
                    });
                }
                let costDisplay = '';
                if (totalCostUSD > 0) {
                    costDisplay = ` / 約 $${totalCostUSD.toFixed(4)} (${totalCostJPY.toFixed(1)}円)`;
                    if (hasUnregisteredModel) {
                        costDisplay += '*';
                    }
                } else if (hasUnregisteredModel) {
                    costDisplay = ` / 💸 - (価格未登録)`;
                }

                const div = document.createElement('div');
                div.className = 'bg-white border rounded p-3 shadow-sm hover:shadow-md transition cursor-pointer flex flex-col relative group';
                div.innerHTML = `
                    <div class="font-bold text-gray-800 text-sm mb-1 truncate pr-6">${session.title || '無題のセッション'}</div>
                    <div class="text-xs text-gray-500 mb-1">期間: ${session.startDate} 〜 ${session.endDate}</div>
                    <div class="text-xs text-blue-600 font-bold">消費トークン: ${session.totalTokens || 0}${costDisplay}</div>
                    <button class="absolute top-2 right-2 text-gray-400 hover:text-red-500 opacity-0 group-hover:opacity-100 transition btn-delete-session" data-id="${session.id}" title="削除">🗑️</button>
                `;
                // セッションクリックで開く
                div.addEventListener('click', (e) => {
                    if (e.target.closest('.btn-delete-session')) return; // ゴミ箱クリック時は無視
                    openAiSession(session.id);
                });
                // 削除ボタン
                div.querySelector('.btn-delete-session').addEventListener('click', (e) => {
                    e.stopPropagation();
                    if (confirm('このセッション履歴を削除しますか？')) {
                        deleteAiSession(session.id);
                    }
                });
                aiSessionList.appendChild(div);
            });
        }
    }

    function deleteAiSession(id) {
        let sessions = JSON.parse(localStorage.getItem('ai_sessions') || '[]');
        sessions = sessions.filter(s => s.id !== id);
        localStorage.setItem('ai_sessions', JSON.stringify(sessions));
        loadAiSessions();
    }

    function openAiSession(id) {
        currentSessionId = id;
        aiSessionsView.classList.add('hidden');
        aiChatView.classList.remove('hidden');
        btnBackToSessions.classList.remove('hidden');
        
        // セッションを開く前に、仮プレビュー（バックアップ）があれば復元し、プレビューバーを非表示にする
        if (allTasksRawBackup) {
            allTasksRaw = JSON.parse(JSON.stringify(allTasksRawBackup));
            allTasksRawBackup = null;
            renderGantt();
        }
        if (aiPreviewBar) {
            aiPreviewBar.classList.add('hidden');
        }
        
        const sessions = JSON.parse(localStorage.getItem('ai_sessions') || '[]');
        const session = sessions.find(s => s.id === id);
        if (session) {
            aiPanelTitle.textContent = session.title || 'AIセッション';
            const periodEl = document.getElementById('ai-panel-period');
            if (periodEl) {
                if (session.startDate && session.endDate) {
                    periodEl.textContent = `対象期間: ${session.startDate} 〜 ${session.endDate}`;
                    periodEl.classList.remove('hidden');
                } else {
                    periodEl.classList.add('hidden');
                }
            }
            renderAiChatMessages(session.messages || []);
        } else {
            renderAiChatMessages([]);
        }
    }

    // --- AI Preview Bar Logic (スプシ風) ---
    const aiPreviewBar = document.getElementById('ai-preview-bar');
    const btnAiPreviewSave = document.getElementById('btn-ai-preview-save');
    const btnAiPreviewDiscard = document.getElementById('btn-ai-preview-discard');

    if (btnAiPreviewSave) {
        btnAiPreviewSave.addEventListener('click', async () => {
            try {
                btnAiPreviewSave.disabled = true;
                btnAiPreviewSave.textContent = '保存中...';
                
                // ツール本来の「保存」ボタンを取得
                const btnSave = document.getElementById('btn-save');
                if (btnSave) {
                    // プログラム上からクリックイベントを発火させ、
                    // デッドラインやキャラクターマスターの順序整列を含めたすべての整合性を保って完全に保存します。
                    btnSave.click();
                    
                    // バックアップをクリアし、プレビューバーを非表示にする
                    allTasksRawBackup = null;
                    if (aiPreviewBar) {
                        aiPreviewBar.classList.add('hidden');
                    }

                    // セッション内のすべてのAI提案メッセージを「適用済み」としてマーキングする
                    if (currentSessionId) {
                        let sessions = JSON.parse(localStorage.getItem('ai_sessions') || '[]');
                        const sessionIndex = sessions.findIndex(s => s.id === currentSessionId);
                        if (sessionIndex !== -1) {
                            const sessionMessages = sessions[sessionIndex].messages || [];
                            sessionMessages.forEach(msg => {
                                if (msg.role !== 'user') {
                                    msg.isApplied = true;
                                }
                            });
                            sessions[sessionIndex].isApplied = true; // 互換性のためセッションレベルも残す
                            localStorage.setItem('ai_sessions', JSON.stringify(sessions));
                        }
                    }
                } else {
                    alert('システムの保存ボタンが見つかりませんでした。');
                }
            } catch (e) {
                alert('保存時に通信エラーが発生しました: ' + e);
            } finally {
                btnAiPreviewSave.disabled = false;
                btnAiPreviewSave.textContent = '提案を保存';
            }
        });
    }

    if (btnAiPreviewDiscard) {
        btnAiPreviewDiscard.addEventListener('click', () => {
            if (allTasksRawBackup) {
                allTasksRaw = JSON.parse(JSON.stringify(allTasksRawBackup));
                allTasksRawBackup = null;
                renderGantt();
            }
            aiPreviewBar.classList.add('hidden');

            // 破棄した場合も、これ以上プレビューを出さないようにマーキングする
            if (currentSessionId) {
                let sessions = JSON.parse(localStorage.getItem('ai_sessions') || '[]');
                const sessionIndex = sessions.findIndex(s => s.id === currentSessionId);
                if (sessionIndex !== -1) {
                    const sessionMessages = sessions[sessionIndex].messages || [];
                    sessionMessages.forEach(msg => {
                        if (msg.role !== 'user') {
                            msg.isApplied = true; // 適用/破棄済みの意味
                        }
                    });
                    localStorage.setItem('ai_sessions', JSON.stringify(sessions));
                }
            }

            alert('プレビューを破棄し、元のスケジュールに復元しました。');
        });
    }

    function renderAiChatMessages(messages, showLoading = false) {
        const container = document.getElementById('ai-chat-messages');
        container.innerHTML = '';
        if (messages.length === 0 && !showLoading) {
            container.innerHTML = '<div class="text-gray-500 text-center text-xs mt-4">メッセージを入力して会話を始めてください。</div>';
            return;
        }
        
        let foundProposal = false;

        messages.forEach(msg => {
            const div = document.createElement('div');
            const isUser = msg.role === 'user';
            const isError = msg.role === 'error';
            div.className = `flex flex-col ${isUser ? 'items-end' : 'items-start'} space-y-1 mb-3`;
            
            let messageHTML = '';
            let parsedTasks = null;

            if (isUser) {
                let imagesHTML = '';
                if (msg.images && msg.images.length > 0) {
                    imagesHTML = '<div class="flex flex-wrap gap-2 mt-2">';
                    msg.images.forEach(img => {
                        imagesHTML += `<img src="${img}" class="max-h-32 rounded border shadow-sm cursor-pointer hover:opacity-90" onclick="window.open('${img}', '_blank')">`;
                    });
                    imagesHTML += '</div>';
                }
                messageHTML = `<div class="bg-blue-100 border-blue-200 border rounded-lg p-2 text-sm max-w-[90%] whitespace-pre-wrap">${escapeHTML(msg.content)}${imagesHTML}</div>`;
            } else if (msg.role === 'process') {
                const isActive = msg.status === 'active';
                const icon = isActive 
                    ? `<span class="animate-spin h-3 w-3 text-blue-500 rounded-full border-2 border-t-transparent flex-shrink-0"></span>` 
                    : `<span class="text-green-500 font-bold flex-shrink-0 select-none">✔️</span>`;
                const bgClass = isActive 
                    ? 'bg-blue-50/40 border-blue-200/50 border border-dashed animate-pulse text-blue-700' 
                    : 'bg-gray-50 border-gray-200 border text-gray-500';

                messageHTML = `
<details class="${bgClass} rounded-lg p-2 text-xs max-w-[90%] select-none shadow-sm mb-1" ${isActive ? 'open' : ''}>
  <summary class="flex items-center space-x-2 cursor-pointer outline-none">
    ${icon}
    <span class="font-mono font-semibold">${escapeHTML(msg.textDesc)} (${escapeHTML(msg.time)}${msg.tokens || ''})</span>
  </summary>
  <div class="mt-2 pl-6 text-gray-600 bg-white p-2 rounded border border-gray-100 font-mono text-[10px] whitespace-pre-wrap max-h-48 overflow-y-auto">
    ${msg.details ? escapeHTML(msg.details) : '詳細データなし'}
  </div>
</details>`;
            } else if (isError) {
                messageHTML = `
<div class="bg-red-50 border-red-200 border rounded-lg p-3 text-sm max-w-[90%] text-red-700 flex items-start space-x-2 shadow-sm">
  <span class="text-base">⚠️</span>
  <div>
    <div class="font-bold mb-1">エラーが発生しました</div>
    <div class="text-xs break-all whitespace-pre-wrap">${escapeHTML(msg.content)}</div>
  </div>
</div>`;
            } else {
                let parsedContent = typeof marked !== 'undefined' ? marked.parse(msg.content) : escapeHTML(msg.content);

                // HTMLパース後の JSONコードブロックを折りたたみ（アコーディオン）に置換してスッキリさせる
                const htmlJsonRegex = /<pre><code class="language-json">([\s\S]*?)<\/code><\/pre>/gi;
                parsedContent = parsedContent.replace(htmlJsonRegex, (match, p1) => {
                    return `
<details class="bg-white border rounded p-2 mt-2 cursor-pointer select-none">
  <summary class="font-bold text-xs text-blue-600 outline-none hover:text-blue-800">📋 適用された更新データ (JSON) を表示 (クリックで展開)</summary>
  <pre class="text-xs bg-gray-50 p-2 rounded border mt-2 overflow-x-auto max-h-48 text-left"><code>${p1}</code></pre>
</details>
`;
                });

                // 今回のメッセージでのトークン消費・処理ログフッターを追加
                let tokenFooter = '';
                if (msg.tokens || msg.responseTime) {
                    const timeStr = msg.timestamp ? ` [${msg.timestamp}]` : '';
                    const respTimeStr = msg.responseTime ? ` (応答時間: ${msg.responseTime}秒)` : '';
                    
                    let tokenStr = msg.tokens ? `消費: ${msg.tokens} tokens` : '';
                    if (msg.input_tokens !== undefined && msg.output_tokens !== undefined) {
                        tokenStr = `消費: ${msg.tokens} tokens (In: ${msg.input_tokens} / Out: ${msg.output_tokens})`;
                    }
                    
                    // コスト計算
                    let costStr = '';
                    const settings = JSON.parse(localStorage.getItem('ai_settings') || '{}');
                    const rate = settings.usdJpyRate || getUsdJpyRate();
                    const modelName = msg.model || settings.model;
                    
                    const costObj = calculateCost(modelName, msg.tokens, msg.input_tokens, msg.output_tokens, rate);
                    if (costObj) {
                        const usdFormated = costObj.usd < 0.01 ? costObj.usd.toFixed(5) : costObj.usd.toFixed(4);
                        const jpyFormated = costObj.jpy < 0.1 ? costObj.jpy.toFixed(3) : costObj.jpy.toFixed(2);
                        costStr = ` | 💸 約 $${usdFormated} (${jpyFormated}円 @${rate})`;
                    } else {
                        costStr = ` | 💸 - (価格未登録)`;
                    }
                    
                    const modelBadge = modelName ? `<span class="bg-gray-200 text-gray-600 px-1 rounded mr-1 text-[9px] font-mono">${modelName}</span>` : '';
                    
                    tokenFooter = `
<div class="mt-2 border-t pt-1 text-[10px] text-gray-400 font-semibold flex justify-between items-center select-none">
  <span>🪙 ${modelBadge}${tokenStr}${costStr}${respTimeStr}${timeStr}</span>
</div>`;
                }

                messageHTML = `<div class="bg-gray-100 border-gray-200 border rounded-lg p-3 text-sm max-w-[90%] ai-markdown-content">${parsedContent}${tokenFooter}</div>`;

                // メッセージテキスト内からタスク提案JSONを検出（コードブロックまたは配列の正規表現）
                const jsonBlockRegex = /```json\s*([\s\S]*?)\s*```/;
                const match = msg.content.match(jsonBlockRegex);
                let jsonText = match ? match[1] : null;
                
                if (!jsonText) {
                    const arrayMatch = msg.content.match(/\[\s*\{\s*"id"[\s\S]*?\}\s*\]/);
                    if (arrayMatch) {
                        jsonText = arrayMatch[0];
                    }
                }

                if (jsonText) {
                    try {
                        const parsed = JSON.parse(jsonText);
                        // 単純なタスクの配列（id, start, endを含む）であるか確認
                        if (Array.isArray(parsed) && parsed.length > 0 && parsed[0].id && parsed[0].start && parsed[0].end) {
                            parsedTasks = parsed;
                        } else if (parsed.action === 'update_tasks' && Array.isArray(parsed.data)) {
                            parsedTasks = parsed.data;
                        }
                    } catch (e) {
                        // パース失敗時は無視
                    }
                }
            }

            let senderName = 'AIアシスタント';
            if (isUser) senderName = 'あなた';
            else if (isError) senderName = 'システムエラー';
            else if (msg.role === 'process') senderName = '処理プロセス';

            div.innerHTML = `
                <div class="text-xs text-gray-500 font-bold px-1">${senderName}</div>
                ${messageHTML}
            `;

            // タスク提案が検出された場合、自動的にプレビューを実行 (ただし適用済みメッセージの場合はスキップ)
            if (parsedTasks && !isUser && !isError && !msg.isApplied) {
                foundProposal = true;
                
                // バックアップを一度だけ取得
                if (!allTasksRawBackup) {
                    allTasksRawBackup = JSON.parse(JSON.stringify(allTasksRaw));
                }
                
                // 仮反映の実行
                parsedTasks.forEach(taskProp => {
                    const existingTask = allTasksRaw.find(t => t.task_id === taskProp.id);
                    if (existingTask) {
                        existingTask.start_date = taskProp.start;
                        existingTask.end_date = taskProp.end;
                        if (taskProp.name) existingTask.task_name = taskProp.name;
                        if (taskProp.progress !== undefined) existingTask.progress = taskProp.progress;
                    }
                });
            }

            container.appendChild(div);
        });

        // 提案が検出された場合は、ガントチャートを描画更新し、スプシ風のプレビューバナーを表示
        if (foundProposal) {
            renderGantt();
            if (aiPreviewBar) {
                aiPreviewBar.classList.remove('hidden');
            }
        }

        // Loading（考え中...）のぐるぐるマークを末尾に追加
        if (showLoading) {
            const loadingText = typeof showLoading === 'string' ? showLoading : 'スケジュールをパズルしています...';
            const loadingDiv = document.createElement('div');
            loadingDiv.className = 'flex flex-col items-start space-y-1 mb-3 animate-pulse';
            loadingDiv.innerHTML = `
                <div class="text-xs text-gray-500 font-bold px-1">AIアシスタント</div>
                <div class="bg-gray-50 border-gray-200 border rounded-lg p-3 text-sm max-w-[90%] flex items-center space-x-2 text-gray-500 shadow-sm">
                    <svg class="animate-spin h-4 w-4 text-blue-600" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                        <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                        <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                    </svg>
                    <span class="text-xs font-semibold ai-loading-text">AIが考え中... (${loadingText})</span>
                </div>
            `;
            container.appendChild(loadingDiv);
        }

        container.scrollTop = container.scrollHeight;
    }

    function escapeHTML(str) {
        return str.replace(/[&<>"']/g, function(m) {
            return {
                '&': '&',
                '<': '<',
                '>': '>',
                '"': '"',
                "'": '&#039;'
            }[m];
        });
    }

    // 期間指定によるタスク抽出
    function getContextTextForSession(session) {
        const sDate = moment(session.startDate);
        const eDate = moment(session.endDate);
        
        // 該当期間に被るタスクを抽出
        const activeTasks = allTasksRaw.filter(t => {
            const ts = moment(t.start_date);
            const te = moment(t.end_date);
            return (ts.isSameOrBefore(eDate) && te.isSameOrAfter(sDate));
        });

        // 最低限必要な項目に絞ってJSON化（依存関係 dep、セクションID、リリースIDも追加）
        const simpleTasks = activeTasks.map(t => ({
            id: t.task_id,
            name: t.task_name,
            release_id: t.release_id,
            char_id: t.char_id,
            section_id: t.section_id,
            member: masters.member.find(m => m.member_id === t.member_id)?.member_name || '未定',
            start: t.start_date,
            end: t.end_date,
            prog: t.progress,
            dep: t.dependencies || "" // 先行タスクID（カンマ区切り）
        }));

        // 担当者ごとの重複（オーバーラップ）を自動検出して警告サマリーを作成
        let overlapWarnings = "\n【担当者別・タスク期間の重複（オーバーラップ）状況】\n";
        const tasksByMember = {};
        simpleTasks.forEach(t => {
            if (!tasksByMember[t.member]) {
                tasksByMember[t.member] = [];
            }
            tasksByMember[t.member].push(t);
        });

        let hasOverlapTotal = false;
        for (const memberName in tasksByMember) {
            const mTasks = tasksByMember[memberName];
            // 開始日順にソート
            mTasks.sort((a, b) => moment(a.start).diff(moment(b.start)));
            
            let memberOverlaps = [];
            for (let i = 0; i < mTasks.length - 1; i++) {
                const current = mTasks[i];
                const next = mTasks[i + 1];
                const currentEnd = moment(current.end);
                const nextStart = moment(next.start);
                
                if (nextStart.isSameOrBefore(currentEnd)) {
                    hasOverlapTotal = true;
                    memberOverlaps.push(`  - ⚠️ 重複あり: 「${current.name}」(ID: ${current.id}, 期間: ${current.start}〜${current.end}) と 「${next.name}」(ID: ${next.id}, 期間: ${next.start}〜${next.end}) が被っています。`);
                }
            }
            if (memberOverlaps.length > 0) {
                overlapWarnings += `- 担当者 [ ${memberName} ] :\n${memberOverlaps.join('\n')}\n`;
            }
        }
        if (!hasOverlapTotal) {
            overlapWarnings += "  - 現在、すべての担当者においてタスクの重複（被り）はありません。\n";
        }

        // アクティブなリリース情報（アート締め期限）を抽出
        const activeReleaseIds = new Set(simpleTasks.map(t => t.release_id));
        const activeReleasesInfo = (masters.release || [])
            .filter(r => activeReleaseIds.has(r.release_id))
            .map(r => ({
                id: r.release_id,
                name: r.release_name,
                art_deadline: r.art_deadline // アート締め（絶対にこれを超えてタスクを配置してはならない）
            }));

        // アクティブなセクション締め（マイルストーン）情報を抽出
        const activeDeadlines = (deadlinesRaw || [])
            .filter(d => activeReleaseIds.has(d.release_id))
            .map(d => ({
                release_id: d.release_id,
                char_id: d.char_id,
                section_id: d.section_id,
                deadline_date: d.deadline_date // セクション締め（絶対にこれを超えて該当セクションのタスクを配置してはならない）
            }));

        let contextText = `\n--- プロジェクトコンテキスト ---\n【マスターデータ】\nキャラクター: ${JSON.stringify(masters.character.map(c=>({id:c.char_id, name:c.char_name})))}\n`;
        contextText += `担当者: ${JSON.stringify(masters.member.map(m=>({id:m.member_id, name:m.member_name})))}\n`;
        contextText += `バージョン情報（アート締め）: ${JSON.stringify(activeReleasesInfo)}\n`;
        contextText += `セクション締め（マイルストーン）: ${JSON.stringify(activeDeadlines)}\n\n`;
        contextText += `【対象期間(${session.startDate}〜${session.endDate})のタスク（"dep"は先行タスクID）】\n`;
        contextText += JSON.stringify(simpleTasks, null, 2) + "\n";
        contextText += overlapWarnings;
        return contextText;
    }

    // チャット送信処理
    let isAiSending = false;
    let currentAbortController = null;

    const aiChatInput = document.getElementById('ai-chat-input');
    const btnAiSend = document.getElementById('btn-ai-send');
    if (btnAiSend && aiChatInput) {
        // Ctrl+Enterで送信
        aiChatInput.addEventListener('keydown', (e) => {
            if (e.ctrlKey && e.key === 'Enter') {
                if (!isAiSending) btnAiSend.click();
            }
        });

        // クリップボードからの画像ペースト対応
        aiChatInput.addEventListener('paste', (e) => {
            const items = e.clipboardData.items;
            for (let i = 0; i < items.length; i++) {
                if (items[i].type.indexOf('image') !== -1) {
                    const blob = items[i].getAsFile();
                    const reader = new FileReader();
                    reader.onload = function(evt) {
                        const base64 = evt.target.result;
                        attachedImages.push(base64);
                        renderImagePreviews();
                    };
                    reader.readAsDataURL(blob);
                }
            }
        });

        function renderImagePreviews() {
            const container = document.getElementById('ai-chat-preview-container');
            if (!container) return;
            
            container.innerHTML = '';
            if (attachedImages.length > 0) {
                container.classList.remove('hidden');
                attachedImages.forEach((img, index) => {
                    const wrapper = document.createElement('div');
                    wrapper.className = 'relative inline-block mr-2';
                    wrapper.innerHTML = `
                        <img src="${img}" class="h-16 w-16 object-cover border rounded shadow-sm">
                        <button class="absolute -top-1 -right-1 bg-red-500 text-white rounded-full w-4 h-4 text-xs flex items-center justify-center font-bold hover:bg-red-600 shadow" data-index="${index}">×</button>
                    `;
                    wrapper.querySelector('button').addEventListener('click', (e) => {
                        const idx = parseInt(e.target.getAttribute('data-index'));
                        attachedImages.splice(idx, 1);
                        renderImagePreviews();
                    });
                    container.appendChild(wrapper);
                });
            } else {
                container.classList.add('hidden');
            }
        }

        btnAiSend.addEventListener('click', async () => {
            if (isAiSending) {
                // すでに送信中の場合は「停止（中断）」として機能する
                if (currentAbortController) {
                    currentAbortController.abort();
                }
                return;
            }

            const text = aiChatInput.value.trim();
            if (!text || !currentSessionId) return;

            const aiSettings = JSON.parse(localStorage.getItem('ai_settings') || '{}');
            if (!aiSettings.apiKey || !aiSettings.model) {
                alert('右上の歯車アイコンからAPIキーとモデルを設定してください。');
                return;
            }

            // セッションデータの取得
            let sessions = JSON.parse(localStorage.getItem('ai_sessions') || '[]');
            let sessionIndex = sessions.findIndex(s => s.id === currentSessionId);
            if (sessionIndex < 0) return;
            let session = sessions[sessionIndex];

            // 履歴用のユーザーメッセージ（ファイル添付がある場合は、それとわかるよう注記）
            const displayContent = attachedFileName ? `${text}\n\n[添付ファイル: ${attachedFileName}]` : text;

            // 送信用メッセージの構築（ファイルがあれば中身を結合）
            let sendContent = text;
            if (attachedFileContent) {
                sendContent += `\n\n【添付ファイル: ${attachedFileName} の中身】\n${attachedFileContent}`;
            }

            session.messages = session.messages || [];
            session.messages.push({ 
                role: 'user', 
                content: displayContent,
                images: [...attachedImages] // 添付画像を履歴用に保存
            });
            
            // 初回送信時にタイトル自動生成（簡易）
            if (session.messages.length === 1) {
                session.title = text.substring(0, 15) + (text.length > 15 ? '...' : '');
                aiPanelTitle.textContent = session.title;
            }

            // 送信用メッセージ履歴をディープコピーして、会話メッセージ（user/assistant）のみにフィルタリング
            let sendMessages = session.messages.filter(m => m.role === 'user' || m.role === 'assistant').map(m => {
                return {
                    role: m.role,
                    content: m.content
                };
            });
            if (sendMessages.length > 0) {
                sendMessages[sendMessages.length - 1].content = sendContent;
            }

            // 💸 お財布大爆発防止ブレーキ（トークン節約機能）
            if (sendMessages.length > 6) {
                sendMessages = sendMessages.slice(-6);
            }

            // 送信用システムプロンプトの構築
            let sysPrompt = aiSettings.systemPrompt || 'あなたはプロジェクト管理アシスタントです。';
            sysPrompt += getContextTextForSession(session);

            // 【常時追加されるシステムコアプロンプト】
            // ガントチャートのリアルタイムプレビュー等の複雑なパズルは行わず、俯瞰的な質疑応答のみを行う
            sysPrompt += `
【指示】
あなたはプロジェクト管理のAIアシスタントです。
上記のプロジェクト情報（タスクリスト、担当者、マスターデータなど）を俯瞰的に分析し、ユーザーの質問に対して的確で分かりやすいアドバイスや回答を提供してください。
スケジュールを直接修正するためのJSONコードなどは出力する必要はありません。テキストで回答してください。
`;

            // プロセス表示タイマー
            let processTimer = null;
            const p1 = { role: 'process', stepId: 1, textDesc: "AIが回答を生成中...", status: 'active', time: '0.0', details: null, tokens: null };
            session.messages.push(p1);

            aiChatInput.value = '';
            
            // 送信ボタンを「■ 中断」に切り替える（disabledにはしない！）
            isAiSending = true;
            btnAiSend.textContent = '■ 中断';
            btnAiSend.classList.remove('bg-blue-500', 'hover:bg-blue-600');
            btnAiSend.classList.add('bg-red-500', 'hover:bg-red-600');

            // AbortControllerの初期化
            currentAbortController = new AbortController();

            const startTime = Date.now();

            processTimer = setInterval(() => {
                const now = Date.now();
                const elapsedSinceStart = now - startTime;
                p1.time = (elapsedSinceStart / 1000).toFixed(1);
                renderAiChatMessages(session.messages, false);
            }, 100);

            try {
                // --- API Call ---
                const res1 = await fetch('/api/llm/chat', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        provider: aiSettings.provider,
                        apiKey: aiSettings.apiKey,
                        model: aiSettings.model,
                        temperature: aiSettings.temperature,
                        systemPrompt: sysPrompt,
                        messages: sendMessages,
                        images: attachedImages // ペースト画像を追加
                    }),
                    signal: currentAbortController.signal
                });
                const data1 = await res1.json();
                if (data1.status !== 'success') throw new Error(data1.message);

                let finalTokens = data1.tokens;
                let finalReply = data1.reply;

                p1.status = 'done';
                p1.details = '処理完了';
                p1.tokens = ' / ' + finalTokens + ' tokens';

                const endTime = Date.now();
                const elapsedSeconds = ((endTime - startTime) / 1000).toFixed(1);
                const currentTimeStr = new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

                const rate = aiSettings.usdJpyRate || getUsdJpyRate();
                session.messages.push({ 
                    role: 'assistant', 
                    content: finalReply, 
                    tokens: finalTokens,
                    input_tokens: data1.input_tokens,
                    output_tokens: data1.output_tokens,
                    model: aiSettings.model,
                    responseTime: elapsedSeconds,
                    timestamp: currentTimeStr
                });

                session.totalTokens = (session.totalTokens || 0) + finalTokens;
                const costObj = calculateCost(aiSettings.model, finalTokens, data1.input_tokens, data1.output_tokens, rate);
                if (costObj) {
                    session.totalCostUSD = (session.totalCostUSD || 0) + costObj.usd;
                    session.totalCostJPY = (session.totalCostJPY || 0) + costObj.jpy;
                }
                renderAiChatMessages(session.messages);

                if (btnRemoveAttachment) btnRemoveAttachment.click();

            } catch (e) {
                if (e.name === 'AbortError') {
                    session.messages.push({ role: 'error', content: 'ユーザーによって処理が中断されました。' });
                    renderAiChatMessages(session.messages, false);
                } else {
                    session.messages.push({ role: 'error', content: `通信エラー: ${e.message || e}` });
                    renderAiChatMessages(session.messages, false);
                }
            } finally {
                if (processTimer) clearInterval(processTimer);
                isAiSending = false;
                currentAbortController = null;
                btnAiSend.textContent = '送信';
                btnAiSend.classList.remove('bg-red-500', 'hover:bg-red-600');
                btnAiSend.classList.add('bg-blue-500', 'hover:bg-blue-600');
                
                // 画像添付初期化
                attachedImages = [];
                renderImagePreviews();

                sessions[sessionIndex] = session;
                localStorage.setItem('ai_sessions', JSON.stringify(sessions));
            }
        });
    }

    // マスターの自動適用・保存処理
    async function autoUpdateMasters(newData) {
        if (!confirm('AIオペレーターによるマスターデータ変更指示が検出されました。\nこの内容を適用し、CSVファイルを上書き保存しますか？')) {
            return;
        }
        
        try {
            // ローカルメモリ上の masters オブジェクトをマージ
            for (let key in newData) {
                if (masters[key]) {
                    masters[key] = newData[key];
                }
            }
            
            // Flaskサーバーに保存リクエストをPOST
            const res = await fetch(`/api/masters/save?project=${currentProject}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(newData)
            });
            const resData = await res.json();
            if (resData.status === 'success') {
                alert('マスターデータを自動更新し、CSVを上書き保存しました！\nページをリロードして変更を反映してください。');
                window.location.reload();
            } else {
                alert('自動更新保存エラー: ' + resData.message);
            }
        } catch (e) {
            alert('マスターデータの自動保存に失敗しました: ' + e);
        }
    }

    // 期間入力のバリデーション
    function validateNewSession() {
        if (newSessionStart.value && newSessionEnd.value && newSessionStart.value <= newSessionEnd.value) {
            btnStartNewSession.disabled = false;
        } else {
            btnStartNewSession.disabled = true;
        }
    }
    if (newSessionStart && newSessionEnd) {
        newSessionStart.addEventListener('change', validateNewSession);
        newSessionEnd.addEventListener('change', validateNewSession);
    }

    // 新規セッション開始
    if (btnStartNewSession) {
        btnStartNewSession.addEventListener('click', () => {
            const id = 'sess_' + Date.now();
            const session = {
                id: id,
                title: '新規セッション',
                startDate: newSessionStart.value,
                endDate: newSessionEnd.value,
                totalTokens: 0,
                messages: []
            };
            const sessions = JSON.parse(localStorage.getItem('ai_sessions') || '[]');
            sessions.push(session);
            localStorage.setItem('ai_sessions', JSON.stringify(sessions));
            
            // 入力リセット
            newSessionStart.value = '';
            newSessionEnd.value = '';
            validateNewSession();
            
            openAiSession(id);
        });
    }

    // 戻るボタン
    if (btnBackToSessions) {
        btnBackToSessions.addEventListener('click', () => {
            currentSessionId = null;
            aiChatView.classList.add('hidden');
            aiSessionsView.classList.remove('hidden');
            btnBackToSessions.classList.add('hidden');
            aiPanelTitle.textContent = 'AIセッション';
            const periodEl = document.getElementById('ai-panel-period');
            if (periodEl) periodEl.classList.add('hidden');
            
            // 戻る際にも仮プレビュー状態（バックアップ）があれば復元し、プレビューバーを非表示にする
            if (allTasksRawBackup) {
                allTasksRaw = JSON.parse(JSON.stringify(allTasksRawBackup));
                allTasksRawBackup = null;
                renderGantt();
            }
            if (aiPreviewBar) {
                aiPreviewBar.classList.add('hidden');
            }
            
            loadAiSessions();
        });
    }

    // チャットパネルの開閉
    if (btnAiChat) {
        btnAiChat.addEventListener('click', () => {
            aiChatPanel.classList.toggle('translate-x-full');
            if (!aiChatPanel.classList.contains('translate-x-full')) {
                loadAiSessions();
            }
        });
    }
    if (btnCloseAiChat) {
        btnCloseAiChat.addEventListener('click', () => {
            aiChatPanel.classList.add('translate-x-full');
        });
    }

    // チャットパネルのリサイズ処理
    const resizeHandle = document.getElementById('ai-chat-resize-handle');
    if (aiChatPanel && resizeHandle) {
        let isResizing = false;
        let startX, startWidth;
        
        resizeHandle.addEventListener('mousedown', (e) => {
            isResizing = true;
            startX = e.clientX;
            startWidth = parseInt(document.defaultView.getComputedStyle(aiChatPanel).width, 10);
            
            // リサイズ中に一時的にトランジションを無効にして追従性を上げる
            aiChatPanel.classList.remove('transition-transform', 'duration-300');
            
            document.addEventListener('mousemove', handleMouseMove);
            document.addEventListener('mouseup', handleMouseUp);
            e.preventDefault();
        });
        
        function handleMouseMove(e) {
            if (!isResizing) return;
            const dx = startX - e.clientX;
            const newWidth = Math.max(300, Math.min(window.innerWidth - 100, startWidth + dx));
            aiChatPanel.style.width = `${newWidth}px`;
        }
        
        function handleMouseUp() {
            isResizing = false;
            aiChatPanel.classList.add('transition-transform', 'duration-300');
            document.removeEventListener('mousemove', handleMouseMove);
            document.removeEventListener('mouseup', handleMouseUp);
        }
    }

    // 設定モーダルの開閉と初期値ロード
    if (btnAiSettings) {
        btnAiSettings.addEventListener('click', () => {
            aiSettingsDialog.classList.remove('hidden');
            
            // LocalStorageから読み込み
            const settings = JSON.parse(localStorage.getItem('ai_settings') || '{}');
            if (settings.provider) aiProvider.value = settings.provider;
            if (settings.apiKey) aiApiKey.value = settings.apiKey;
            if (settings.temperature) {
                aiTemperature.value = settings.temperature;
                aiTempVal.textContent = settings.temperature;
            }
            if (settings.systemPrompt) aiSystemPrompt.value = settings.systemPrompt;
            if (settings.maxRetries !== undefined) document.getElementById('ai-max-retries').value = settings.maxRetries;
            if (settings.usdJpyRate !== undefined) {
                document.getElementById('ai-usd-jpy-rate').value = settings.usdJpyRate;
            } else {
                document.getElementById('ai-usd-jpy-rate').value = getUsdJpyRate();
            }
            
            // プロバイダ変更時のUI切り替え
            aiProvider.dispatchEvent(new Event('change'));
            
            // もしモデルが保存されていればセット
            if (settings.model) {
                setTimeout(() => {
                    const hasOption = Array.from(aiModelSelect.options).some(opt => opt.value === settings.model);
                    if (hasOption) {
                        aiModelSelect.value = settings.model;
                    } else {
                        aiModelSelect.value = '__MANUAL__';
                        aiModelManual.value = settings.model;
                    }
                    triggerModelInputVisibility();
                }, 50);
            } else {
                aiModelSelect.value = aiModelSelect.options[0] ? aiModelSelect.options[0].value : '__MANUAL__';
                triggerModelInputVisibility();
            }
        });
    }

    // プロバイダ変更イベント
    if (aiProvider) {
        aiProvider.addEventListener('change', () => {
            const provider = aiProvider.value;
            
            aiModelSelect.innerHTML = '';
            
            const models = MASTER_MODELS[provider] || [];
            models.forEach(m => {
                const opt = document.createElement('option');
                opt.value = m;
                opt.textContent = m;
                aiModelSelect.appendChild(opt);
            });
            
            const manualOpt = document.createElement('option');
            manualOpt.value = '__MANUAL__';
            manualOpt.textContent = '手動入力する...';
            aiModelSelect.appendChild(manualOpt);
            
            document.getElementById('btn-fetch-models').disabled = false;
            document.getElementById('btn-fetch-models').classList.remove('opacity-50');
            
            triggerModelInputVisibility();
        });
    }

    // モデルセレクトの変更イベント
    if (aiModelSelect) {
        aiModelSelect.addEventListener('change', () => {
            triggerModelInputVisibility();
        });
    }

    function triggerModelInputVisibility() {
        if (aiModelSelect.value === '__MANUAL__' || aiModelSelect.options.length <= 1) {
            aiModelManual.classList.remove('hidden');
        } else {
            aiModelManual.classList.add('hidden');
        }
    }

    // モデルリスト取得
    const btnFetchModels = document.getElementById('btn-fetch-models');
    if (btnFetchModels) {
        btnFetchModels.addEventListener('click', async () => {
            const provider = aiProvider.value;
            const apiKey = aiApiKey.value.trim();
            if (!apiKey) {
                alert('APIキーを入力してください。');
                return;
            }
            
            try {
                btnFetchModels.disabled = true;
                btnFetchModels.textContent = '取得中...';
                
                const res = await fetch('/api/llm/models', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ provider, apiKey })
                });
                const data = await res.json();
                
                if (data.status === 'success') {
                    aiModelSelect.innerHTML = '';
                    data.models.forEach(m => {
                        const opt = document.createElement('option');
                        opt.value = m;
                        opt.textContent = m;
                        aiModelSelect.appendChild(opt);
                    });
                    
                    const manualOpt = document.createElement('option');
                    manualOpt.value = '__MANUAL__';
                    manualOpt.textContent = '手動入力する...';
                    aiModelSelect.appendChild(manualOpt);
                    
                    // もし設定済みのモデルがあれば選択を復元
                    const savedModel = JSON.parse(localStorage.getItem('ai_settings') || '{}').model;
                    if (savedModel && Array.from(aiModelSelect.options).some(o => o.value === savedModel)) {
                        aiModelSelect.value = savedModel;
                    } else {
                        aiModelSelect.value = aiModelSelect.options[0] ? aiModelSelect.options[0].value : '__MANUAL__';
                    }
                    triggerModelInputVisibility();
                    
                    // バックエンドでCSVが自動更新された可能性があるので最新の価格マスタを再読み込み
                    await fetchLlmPricing();
                    
                    alert('モデルリストを更新しました！\n※未知のモデルが見つかった場合、CSVマスタ(data/common/m_llm_pricing.csv)に単価0として自動追記されました。');
                } else {
                    alert('エラー: ' + data.message);
                }
            } catch (e) {
                alert('通信エラーが発生しました: ' + e);
            } finally {
                btnFetchModels.disabled = false;
                btnFetchModels.textContent = '更新';
            }
        });
    }

    // Temperatureスライダー連動
    if (aiTemperature) {
        aiTemperature.addEventListener('input', (e) => {
            aiTempVal.textContent = e.target.value;
        });
    }

    // 設定保存
    if (btnSaveAiSettings) {
        btnSaveAiSettings.addEventListener('click', () => {
            const provider = aiProvider.value;
            const model = aiModelSelect.value === '__MANUAL__' ? aiModelManual.value.trim() : aiModelSelect.value;
            const settings = {
                provider: provider,
                apiKey: aiApiKey.value.trim(),
                model: model,
                temperature: parseFloat(aiTemperature.value),
                systemPrompt: aiSystemPrompt.value,
                maxRetries: parseInt(document.getElementById('ai-max-retries').value || 3),
                usdJpyRate: parseFloat(document.getElementById('ai-usd-jpy-rate').value || getUsdJpyRate())
            };
            localStorage.setItem('ai_settings', JSON.stringify(settings));
            aiSettingsDialog.classList.add('hidden');
            alert('AIアシスタントの設定を保存しました。');
        });
    }

    document.getElementById('btn-apply-task').addEventListener('click', () => {
        saveHistory();
        const raw = {
            task_id: document.getElementById('edit-task-id').value || 'TSK_' + Date.now(),
            release_id: document.getElementById('edit-release').value,
            char_id: document.getElementById('edit-character').value,
            section_id: document.getElementById('edit-section').value,
            task_name: document.getElementById('edit-task-name').value,
            member_id: document.getElementById('edit-member').value,
            start_date: document.getElementById('edit-start').value,
            end_date: document.getElementById('edit-end').value,
            progress: document.getElementById('edit-progress').value,
            status_id: document.getElementById('edit-status').value,
            lane: document.getElementById('edit-task-id').value ? (allTasksRaw.find(t=>t.task_id === document.getElementById('edit-task-id').value).lane || '1') : '1'
        };

        // 依存関係を引き継ぐ
        if (document.getElementById('edit-task-id').value) {
            const existing = allTasksRaw.find(t => t.task_id === document.getElementById('edit-task-id').value);
            if (existing) {
                raw.dependencies = existing.dependencies;
            }
        }

        const targetIdx = allTasksRaw.findIndex(t => t.task_id === raw.task_id);
        if (targetIdx >= 0) {
            allTasksRaw[targetIdx] = raw;
        } else {
            if (insertTargetIndex >= 0 && insertTargetIndex <= allTasksRaw.length) {
                allTasksRaw.splice(insertTargetIndex, 0, raw);
            } else {
                allTasksRaw.push(raw);
            }
        }
        
        insertTargetIndex = -1;

        markUnsaved();
        renderGantt();
        document.getElementById('side-panel').classList.add('translate-x-full');
    });

    document.getElementById('btn-delete-task').addEventListener('click', () => {
        const id = document.getElementById('edit-task-id').value;
        if(confirm('本当に削除しますか？')) {
            saveHistory();
            allTasksRaw = allTasksRaw.filter(t => t.task_id !== id);
            markUnsaved();
            renderGantt();
            document.getElementById('side-panel').classList.add('translate-x-full');
        }
    });

    document.getElementById('filter-section').addEventListener('change', () => {
        renderGantt();
    });
    
    document.getElementById('filter-text').addEventListener('input', () => {
        renderGantt();
    });

    // カスタムメンバーフィルターのUI制御
    const filterMemberBtn = document.getElementById('filter-member-btn');
    const filterMemberDropdown = document.getElementById('filter-member-dropdown');
    const filterMemberSearch = document.getElementById('filter-member-search');

    // カスタムステータスフィルターのUI制御
    const filterStatusBtn = document.getElementById('filter-status-btn');
    const filterStatusDropdown = document.getElementById('filter-status-dropdown');
    const filterStatusSearch = document.getElementById('filter-status-search');

    if (filterMemberBtn) {
        filterMemberBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            filterMemberDropdown.classList.toggle('hidden');
            if (!filterMemberDropdown.classList.contains('hidden')) {
                filterMemberSearch.focus();
            }
            if (filterStatusDropdown) filterStatusDropdown.classList.add('hidden');
        });
    }

    if (filterMemberSearch) {
        filterMemberSearch.addEventListener('input', (e) => {
            const term = e.target.value.trim().toLowerCase();
            document.querySelectorAll('.member-filter-section-group').forEach(group => {
                let hasVisibleChild = false;
                group.querySelectorAll('.member-filter-item').forEach(item => {
                    const cb = item.querySelector('.member-filter-cb');
                    const name = cb.getAttribute('data-name').toLowerCase();
                    if (name.includes(term)) {
                        item.style.display = '';
                        hasVisibleChild = true;
                    } else {
                        item.style.display = 'none';
                    }
                });
                
                if (term === '' || hasVisibleChild) {
                    group.style.display = '';
                } else {
                    group.style.display = 'none';
                }
            });
        });
    }

    if (filterStatusBtn) {
        filterStatusBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            filterStatusDropdown.classList.toggle('hidden');
            if (!filterStatusDropdown.classList.contains('hidden')) {
                filterStatusSearch.focus();
            }
            if (filterMemberDropdown) filterMemberDropdown.classList.add('hidden');
        });
    }

    if (filterStatusSearch) {
        filterStatusSearch.addEventListener('input', (e) => {
            const term = e.target.value.trim().toLowerCase();
            document.querySelectorAll('.status-filter-item').forEach(item => {
                const cb = item.querySelector('.status-filter-cb');
                const name = cb.getAttribute('data-name').toLowerCase();
                if (name.includes(term)) {
                    item.style.display = '';
                } else {
                    item.style.display = 'none';
                }
            });
        });
    }

    // ドロップダウンの外をクリックしたら閉じる
    document.addEventListener('click', (e) => {
        if (filterMemberDropdown && !filterMemberDropdown.classList.contains('hidden')) {
            if (!e.target.closest('#filter-member-container')) {
                filterMemberDropdown.classList.add('hidden');
            }
        }
        if (filterStatusDropdown && !filterStatusDropdown.classList.contains('hidden')) {
            if (!e.target.closest('#filter-status-container')) {
                filterStatusDropdown.classList.add('hidden');
            }
        }
    });

    if (els.toggleProgressLine) {
        els.toggleProgressLine.addEventListener('change', renderProgressLine);
    }

    // --- エクスポート(CSV/印刷)機能 ---
    const btnExportToggle = document.getElementById('btn-export-toggle');
    const exportDropdown = document.getElementById('export-dropdown');
    const btnExportCsv = document.getElementById('btn-export-csv');
    const btnExportPrint = document.getElementById('btn-export-print');

    if (btnExportToggle && exportDropdown) {
        btnExportToggle.addEventListener('click', (e) => {
            e.stopPropagation();
            exportDropdown.classList.toggle('hidden');
        });
    }

    // 外側クリックでエクスポートドロップダウンを閉じる
    document.addEventListener('click', (e) => {
        if (exportDropdown && !exportDropdown.classList.contains('hidden')) {
            if (!e.target.closest('#export-container')) {
                exportDropdown.classList.add('hidden');
            }
        }
    });

    // CSVエクスポート処理
    if (btnExportCsv) {
        btnExportCsv.addEventListener('click', () => {
            exportDropdown.classList.add('hidden');
            
            // 1. CSVデータのヘッダー定義
            const headers = ["タスクID", "バージョン(リリース)", "キャラクター名(衣装名)", "セクション", "タスク名", "担当者", "開始日", "終了日", "進捗率(%)"];
            
            // 2. 表示中タスク(currentFilteredTasks)をマッピング
            const csvRows = [headers];
            currentFilteredTasks.forEach(t => {
                const charObj = t.char_id ? getMasterItem('character', 'char_id', t.char_id) : null;
                const charName = charObj ? `${charObj.char_name}(${charObj.costume_name || 'デフォルト'})` : '';
                const relName = t.release_id ? (getMasterItem('release', 'release_id', t.release_id)?.release_name || '') : '';
                const memberName = t.member_id ? (getMasterItem('member', 'member_id', t.member_id)?.member_name || '') : '未定';
                const sectionName = t.section_id ? (getMasterItem('section', 'section_id', t.section_id)?.section_name || '') : '';
                
                const row = [
                    t.task_id || '',
                    relName,
                    charName,
                    sectionName,
                    t.task_name || '',
                    memberName,
                    t.start_date || '',
                    t.end_date || '',
                    t.progress || '0'
                ];
                
                // カンマやダブルクォーテーションのエスケープ
                const escapedRow = row.map(val => {
                    const str = String(val).replace(/"/g, '""');
                    return `"${str}"`;
                });
                csvRows.push(escapedRow);
            });

            // 3. UTF-8(BOM付き)でBlob作成してダウンロード
            const csvContent = "\ufeff" + csvRows.map(e => e.join(',')).join("\r\n");
            const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
            const url = URL.createObjectURL(blob);
            const link = document.createElement("a");
            
            const dateStr = moment().format('YYYYMMDD');
            link.setAttribute("href", url);
            link.setAttribute("download", `WBS_Export_${currentProject}_${dateStr}.csv`);
            link.style.visibility = 'hidden';
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
        });
    }

    // PDFエクスポート / 印刷処理 (別ウィンドウにHTMLコピー＋固定サイズ化)
    if (btnExportPrint) {
        btnExportPrint.addEventListener('click', () => {
            exportDropdown.classList.add('hidden');
            
            const ganttBodyContent = document.getElementById('gantt-body-content');
            if (!ganttBodyContent) return;

            // 実際の全体の幅と高さをピクセルで取得
            const fullWidth = ganttBodyContent.scrollWidth;
            const fullHeight = ganttBodyContent.scrollHeight;
            const headerHtml = document.getElementById('gantt-header-content') ? document.getElementById('gantt-header-content').innerHTML : '';
            const tasksHtml = document.getElementById('gantt-tasks') ? document.getElementById('gantt-tasks').innerHTML : '';
            const gridHtml = document.getElementById('gantt-grid') ? document.getElementById('gantt-grid').innerHTML : '';
            const rowsHtml = document.getElementById('gantt-rows') ? document.getElementById('gantt-rows').innerHTML : '';

            // 印刷用の新しいウィンドウを開く
            const printWindow = window.open('', '_blank');
            if (!printWindow) {
                alert('ポップアップブロックが有効になっている可能性があります。許可して再試行してください。');
                return;
            }

            // 元のページのスタイルシートをすべて新しいウィンドウに複製する
            let stylesHtml = '';
            document.querySelectorAll('link[rel="stylesheet"], style').forEach(style => {
                stylesHtml += style.outerHTML;
            });

            // 印刷用のHTMLドキュメントを作成
            printWindow.document.write(`
                <!DOCTYPE html>
                <html lang="ja">
                <head>
                    <meta charset="UTF-8">
                    <title>WBS Export Print</title>
                    <script src="https://cdn.tailwindcss.com"></script>
                    ${stylesHtml}
                    <style>
                        /* 印刷専用スタイル：完全に一枚の巨大なキャンバスとして扱う */
                        body, html {
                            margin: 0 !important;
                            padding: 0 !important;
                            background: white !important;
                        }
                        
                        /* 全てを包含するキャンバス */
                        .print-canvas {
                            position: relative;
                            width: ${fullWidth}px;
                            height: ${fullHeight + 120}px;
                            background: white;
                            overflow: hidden;
                        }

                        /* ヘッダー領域 */
                        .print-header {
                            position: absolute;
                            top: 0;
                            left: 0;
                            width: ${fullWidth}px;
                            height: 120px;
                            background: #f9fafb; /* gray-50 */
                            border-bottom: 1px solid #d1d5db;
                        }

                        /* ボディ領域 */
                        .print-body {
                            position: absolute;
                            top: 120px;
                            left: 0;
                            width: ${fullWidth}px;
                            height: ${fullHeight}px;
                        }

                        /* 内部レイヤー */
                        .print-layer {
                            position: absolute;
                            top: 0;
                            left: 0;
                            width: ${fullWidth}px;
                            height: ${fullHeight}px;
                        }

                        /* 印刷時に背景がオフでも枠線が見えるようにする */
                        .gantt-task-item {
                            border: 2px solid rgba(0,0,0,0.8) !important;
                            background-color: #ddd !important;
                        }

                        @media print {
                            @page {
                                size: landscape;
                                margin: 5mm;
                            }
                        }

                        * {
                            -webkit-print-color-adjust: exact !important;
                            color-adjust: exact !important;
                            print-color-adjust: exact !important;
                        }
                    </style>
                </head>
                <body>
                    <div class="print-canvas">
                        <!-- ヘッダー -->
                        <div class="print-header">
                            ${headerHtml}
                        </div>
                        <!-- ボディ -->
                        <div class="print-body">
                            <div class="print-layer" style="z-index: 1;">${gridHtml}</div>
                            <div class="print-layer" style="z-index: 2;">${rowsHtml}</div>
                            <div class="print-layer" style="z-index: 3;">${tasksHtml}</div>
                        </div>
                    </div>
                    <script>
                        window.onload = function() {
                            setTimeout(() => {
                                window.print();
                                window.close();
                            }, 500);
                        };
                    </script>
                </body>
                </html>
            `);
            printWindow.document.close();
        });
    }
    
    // els.ganttTasks.addEventListener('dblclick', (e) => {
    // ダブルクリックによるエディタ展開は廃止（コンテキストメニューに移行）
    // -> ユーザー要望により復元
    els.ganttBody.addEventListener('dblclick', (e) => {
        const taskEl = e.target.closest('.gantt-task-item');
        if (taskEl) {
            const taskId = taskEl.getAttribute('data-task-id');
            if (taskId) {
                openEditor(taskId, 'task');
            }
        } else {
            const rect = els.ganttBodyContent.getBoundingClientRect();
            const mouseY = e.clientY - rect.top;
            const rowIndex = Math.floor(mouseY / ganttConfig.rowHeight);
            if (rowIndex >= 0 && rowIndex < ganttConfig.groups.length) {
                const group = ganttConfig.groups[rowIndex];
                if (group && (group.type === 'release' || group.type === 'character')) {
                    openEditor(group, 'group');
                }
            }
        }
    });

    els.ganttBody.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        
        // 右クリック時はポップアップ（ツールチップ）を非表示にする
        if (els.taskTooltip) {
            els.taskTooltip.classList.add('hidden');
        }

        const taskEl = e.target.closest('.gantt-task-item');
        
        if (taskEl) {
            currentTaskContextId = taskEl.getAttribute('data-task-id');
            document.querySelectorAll('.gantt-task-item').forEach(el => el.classList.remove('selected'));
            taskEl.classList.add('selected');
        } else {
            currentTaskContextId = null;
        }

        const rect = els.ganttBodyContent.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;
        
        lastMouseTime = xToDate(mouseX).toDate();
        const rowIndex = Math.floor(mouseY / ganttConfig.rowHeight);
        let hoveredGroup = null;
        if (rowIndex >= 0 && rowIndex < ganttConfig.groups.length) {
            lastMouseGroup = ganttConfig.groups[rowIndex].id;
            hoveredGroup = ganttConfig.groups[rowIndex];
        } else {
            lastMouseGroup = null;
        }

        const contextMenu = document.getElementById('context-menu');
        if (contextMenu) {
            contextMenu.style.zIndex = '20000'; // 最前面にする
            // 全てのメニューアイテムを表示し、一旦有効化する
            contextMenu.querySelectorAll('.menu-item').forEach(el => {
                el.classList.remove('hidden');
                el.classList.remove('opacity-50', 'pointer-events-none');
            });

            // 状態に応じてグレーアウト（無効化）する
            if (currentTaskContextId) {
                // タスク上の場合: タスク作成・ペーストを無効化
                contextMenu.querySelectorAll('#ctx-create-task, #ctx-paste').forEach(el => el.classList.add('opacity-50', 'pointer-events-none'));
            } else {
                // 空白（レーン上等）の場合: 編集・タスク関連操作を無効化
                contextMenu.querySelectorAll('.ctx-item-edit, .ctx-item-task').forEach(el => el.classList.add('opacity-50', 'pointer-events-none'));
                // ペーストはコピーされたタスクがない場合は無効化
                if (!copiedTaskRaw) {
                    document.getElementById('ctx-paste').classList.add('opacity-50', 'pointer-events-none');
                }
            }

            contextMenu.style.left = e.clientX + 'px';
            contextMenu.style.top = e.clientY + 'px';
            contextMenu.classList.remove('hidden');
        }
    });

    // コンテキストメニューのアクション追加
    document.getElementById('ctx-edit')?.addEventListener('click', () => {
        if (currentTaskContextId) {
            openEditor(currentTaskContextId, 'task');
        } else if (lastMouseGroup) {
            const group = ganttConfig.groups.find(g => g.id === lastMouseGroup);
            if (group && (group.type === 'release' || group.type === 'character')) {
                openEditor(group, 'group');
            }
        }
        document.getElementById('context-menu').classList.add('hidden');
    });

    document.getElementById('ctx-create-task')?.addEventListener('click', () => {
        if (lastMouseTime) {
            // 行が存在しない空白部分でも作成可能にするため、lastMouseGroupがなくても開く
            openEditorNew(lastMouseGroup || null, lastMouseTime);
        }
        document.getElementById('context-menu').classList.add('hidden');
    });

    document.addEventListener('click', (e) => {
        if (!e.target.closest('#context-menu') && e.button !== 2) {
            const contextMenu = document.getElementById('context-menu');
            if (contextMenu) contextMenu.classList.add('hidden');
        }
    });

    document.addEventListener('keydown', (e) => {
        // 入力フォーム等にフォーカスがある場合はスキップ
        if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;

        if (e.ctrlKey && e.code === 'KeyZ') {
            e.preventDefault();
            if (e.shiftKey) {
                if (typeof performRedo === 'function') performRedo();
            } else {
                if (typeof performUndo === 'function') performUndo();
            }
        } else if (e.ctrlKey && e.code === 'KeyY') {
            e.preventDefault();
            if (typeof performRedo === 'function') performRedo();
        } else if (e.ctrlKey && e.key === 'c') {
            if (currentTaskContextId) {
                const t = allTasksRaw.find(x => x.task_id === currentTaskContextId);
                if (t) copiedTaskRaw = JSON.parse(JSON.stringify(t));
            }
        } else if (e.ctrlKey && e.key === 'v') {
            if (copiedTaskRaw && currentHoverGroup && currentHoverDate) {
                pasteTask(currentHoverGroup, currentHoverDate);
            }
        } else if (e.key === 'Delete') {
            if (currentTaskContextId) {
                if (confirm('選択中のタスクを削除しますか？')) {
                    saveHistory();
                    allTasksRaw = allTasksRaw.filter(t => t.task_id !== currentTaskContextId);
                    markUnsaved();
                    renderGantt();
                }
            }
        }
    });

    document.querySelectorAll('.context-progress').forEach(el => {
        el.addEventListener('click', (e) => {
            if (currentTaskContextId) {
                saveHistory();
                const prog = e.target.getAttribute('data-progress');
                const t = allTasksRaw.find(x => x.task_id === currentTaskContextId);
                if (t) t.progress = prog;
                markUnsaved();
                renderGantt();
                document.getElementById('context-menu').classList.add('hidden');
            }
        });
    });

    document.getElementById('ctx-copy').addEventListener('click', () => {
        if (currentTaskContextId) {
            const t = allTasksRaw.find(x => x.task_id === currentTaskContextId);
            if (t) copiedTaskRaw = JSON.parse(JSON.stringify(t));
        }
        document.getElementById('context-menu').classList.add('hidden');
    });

    document.getElementById('ctx-paste').addEventListener('click', () => {
        if (copiedTaskRaw && lastMouseGroup && lastMouseTime) {
            pasteTask(lastMouseGroup, lastMouseTime);
        }
        document.getElementById('context-menu').classList.add('hidden');
    });

    document.getElementById('ctx-delete').addEventListener('click', () => {
        if (currentTaskContextId) {
            if (confirm('選択中のタスクを削除しますか？')) {
                saveHistory();
                allTasksRaw = allTasksRaw.filter(t => t.task_id !== currentTaskContextId);
                markUnsaved();
                renderGantt();
            }
        }
        document.getElementById('context-menu').classList.add('hidden');
    });
}

function pasteTask(targetGroup, targetTime) {
    if (!copiedTaskRaw) return;
    saveHistory();
    const newRaw = JSON.parse(JSON.stringify(copiedTaskRaw));
    newRaw.task_id = 'TSK_' + Date.now();
    
    const parts = targetGroup.split('_');
    if (parts.length >= 4) {
        newRaw.release_id = parts[0] + '_' + parts[1];
        newRaw.char_id = parts[2] + '_' + parts[3];
        newRaw.lane = parts[4] ? parts[4].replace('LANE', '') : '1';
    }
    
    const oldStart = moment(copiedTaskRaw.start_date);
    const oldEnd = moment(copiedTaskRaw.end_date);
    const durationDays = oldEnd.diff(oldStart, 'days');
    
    const newStart = moment(targetTime).startOf('day');
    newRaw.start_date = newStart.format('YYYY-MM-DD');
    newRaw.end_date = newStart.clone().add(durationDays, 'days').format('YYYY-MM-DD');
    
    allTasksRaw.push(newRaw);
    markUnsaved();
    renderGantt();
}

function findDependencyTarget(clientX, clientY) {
    const items = document.querySelectorAll('.gantt-task-item');
    let bestTargetId = null;
    let minDistance = 50;
    
    items.forEach(el => {
        const id = el.getAttribute('data-task-id');
        if (id === dependencyDragSourceId) return;
        
        const rect = el.getBoundingClientRect();
        const targetX = rect.left;
        const targetY = rect.top + rect.height / 2;
        
        const distance = Math.hypot(clientX - targetX, clientY - targetY);
        const isOnTask = (clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom);
        
        if (isOnTask) {
            bestTargetId = id;
            minDistance = 0;
        } else if (distance < minDistance) {
            minDistance = distance;
            bestTargetId = id;
        }
    });
    
    return bestTargetId;
}

function addDependency(fromId, toId) {
    saveHistory();

    const task = allTasksRaw.find(t => t.task_id === toId);
    if (!task) return;
    
    let deps = task.dependencies ? task.dependencies.split(/[,;]/).map(s => s.trim()).filter(s => s) : [];
    
    if (deps.includes(fromId)) return;
    if (isCircularDependency(toId, fromId)) {
        alert("循環依存（お互い、または輪のように先行後続が巡る構造）になるため、結線できません。");
        return;
    }
    
    deps.push(fromId);
    task.dependencies = deps.join(',');
    
    markUnsaved();
    renderGantt();
}

function isCircularDependency(sourceId, targetId, visited = new Set()) {
    if (targetId === sourceId) return true;
    if (visited.has(targetId)) return false;
    
    visited.add(targetId);
    
    const task = allTasksRaw.find(t => t.task_id === targetId);
    if (!task || !task.dependencies) return false;
    
    const deps = task.dependencies.split(/[,;]/).map(s => s.trim()).filter(s => s);
    for (const depId of deps) {
        if (isCircularDependency(sourceId, depId, visited)) {
            return true;
        }
    }
    
    return false;
}

let currentDependencyContext = null;

function showDependencyLineContextMenu(e, fromId, toId) {
    currentDependencyContext = { fromId, toId };
    
    const menu = document.getElementById('dependency-context-menu');
    if (!menu) {
        const div = document.createElement('div');
        div.id = 'dependency-context-menu';
        div.className = 'fixed bg-white border border-gray-300 rounded shadow-lg py-1 text-sm hidden';
        div.style.zIndex = '30000';
        div.innerHTML = `
            <button id="btn-delete-dependency" class="w-full text-left px-4 py-2 hover:bg-red-500 hover:text-white flex items-center space-x-2">
                <span>❌</span>
                <span>この依存関係（線を消す）</span>
            </button>
        `;
        document.body.appendChild(div);
        
        document.getElementById('btn-delete-dependency').addEventListener('click', () => {
            if (currentDependencyContext) {
                removeDependency(currentDependencyContext.fromId, currentDependencyContext.toId);
                currentDependencyContext = null;
            }
            div.classList.add('hidden');
        });
    }
    
    const menuEl = document.getElementById('dependency-context-menu');
    menuEl.style.left = `${e.clientX}px`;
    menuEl.style.top = `${e.clientY}px`;
    menuEl.classList.remove('hidden');
    
    const closeMenu = (event) => {
        if (!event.target.closest('#dependency-context-menu')) {
            menuEl.classList.add('hidden');
            document.removeEventListener('click', closeMenu);
        }
    };
    setTimeout(() => {
        document.addEventListener('click', closeMenu);
    }, 10);
}

function removeDependency(fromId, toId) {
    saveHistory();
    const task = allTasksRaw.find(t => t.task_id === toId);
    if (!task || !task.dependencies) return;
    
    let deps = task.dependencies.split(/[,;]/).map(s => s.trim()).filter(s => s);
    deps = deps.filter(id => id !== fromId);
    
    task.dependencies = deps.join(',');
    
    markUnsaved();
    renderGantt();
}

function getMinStartLimit(taskId, excludeIds = new Set()) {
    const task = allTasksRaw.find(t => t.task_id === taskId);
    if (!task || !task.dependencies) return null;
    
    const depIds = task.dependencies.split(/[,;]/).map(s => s.trim()).filter(s => s);
    let maxEndDate = null;
    
    depIds.forEach(depId => {
        if (excludeIds.has(depId)) return;
        const depTask = allTasksRaw.find(t => t.task_id === depId);
        if (depTask) {
            const endM = moment(depTask.end_date);
            if (!maxEndDate || endM.isAfter(maxEndDate)) {
                maxEndDate = endM;
            }
        }
    });
    
    return maxEndDate;
}

function pushSuccessorsRecursive(predecessorId) {
    const predTask = allTasksRaw.find(t => t.task_id === predecessorId);
    if (!predTask) return;
    
    const predEnd = moment(predTask.end_date);
    
    const successorTasks = allTasksRaw.filter(t => {
        if (!t.dependencies) return false;
        const depIds = t.dependencies.split(/[,;]/).map(s => s.trim());
        return depIds.includes(predecessorId);
    });
    
    successorTasks.forEach(succTask => {
        const succStart = moment(succTask.start_date);
        
        // 後続タスクの開始日が先行の終了日以前（または終了日と同日）の場合、押し出す
        if (succStart.isBefore(predEnd.clone().add(1, 'days'))) {
            const succDuration = moment(succTask.end_date).diff(succStart, 'days');
            const newStart = predEnd.clone().add(1, 'days');
            const newEnd = newStart.clone().add(succDuration, 'days');
            
            succTask.start_date = newStart.format('YYYY-MM-DD');
            succTask.end_date = newEnd.format('YYYY-MM-DD');
            
            // 後続タスクも再帰的に押し出す
            pushSuccessorsRecursive(succTask.task_id);
        }
    });
}

init();