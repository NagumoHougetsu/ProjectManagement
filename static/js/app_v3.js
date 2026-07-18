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
    crosshairCol: document.getElementById('gantt-crosshair-col'),
    crosshairRow: document.getElementById('gantt-crosshair-row'),
    unsavedBadge: document.getElementById('unsaved-badge')
};

let currentTaskContextId = null;
let lastMouseTime = null;
let lastMouseGroup = null;
let currentHoverDate = null;
let currentHoverGroup = null;

// --- Initialization ---
async function init() {
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
            
            filterMemberList.innerHTML = masters.member.map(m => `
                <label class="flex items-center space-x-2 px-2 py-1 hover:bg-gray-100 rounded cursor-pointer member-filter-item">
                    <input type="checkbox" class="member-filter-cb" value="${m.member_id}" data-name="${m.member_name}" ${currentSelected.includes(m.member_id) ? 'checked' : ''}>
                    <span>${m.member_name}</span>
                </label>
            `).join('');

            // イベントリスナーの再設定
            document.querySelectorAll('.member-filter-cb').forEach(cb => {
                cb.addEventListener('change', () => {
                    updateMemberFilterText();
                    renderGantt();
                });
            });
            updateMemberFilterText();
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
function renderGantt() {
    ganttConfig.totalDays = ganttConfig.endDate.diff(ganttConfig.startDate, 'days');
    const totalWidth = ganttConfig.totalDays * ganttConfig.dayWidth;
    
    els.ganttHeaderContent.style.width = `${totalWidth}px`;
    els.ganttGrid.style.width = `${totalWidth}px`;
    els.ganttRows.style.width = `${totalWidth}px`;
    els.ganttTasks.style.width = `${totalWidth}px`;
    els.ganttBodyContent.style.width = `${totalWidth}px`;

    buildGroupsList();
    renderHeaderAndGrid(totalWidth);
    renderRows();
    renderTasks();
}

function buildGroupsList() {
    ganttConfig.groups = [];
    if (!masters.release || !masters.character) return;

    // タスクから必要な組み合わせを抽出
    const activeReleases = new Set();
    const activeChars = new Set();
    
    allTasksRaw.forEach(t => {
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

        masters.character.forEach(char => {
            const charId = `${rel.release_id}_${char.char_id}`;
            if (!activeChars.has(charId)) return;

            ganttConfig.groups.push({
                id: charId, type: 'character', name: `${char.char_name} (${char.costume_name})`, parentId: relId, level: 1, raw: char
            });
            
            if (ganttConfig.collapsedGroups.has(charId)) return;
            
            for (let i = 1; i <= 3; i++) {
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
    
    let yearHtml = '<div class="absolute top-0 left-0 w-full flex border-b border-gray-300 bg-white" style="height:24px;">';
    let monthHtml = '<div class="absolute left-0 w-full flex border-b border-gray-300 bg-white" style="top:24px; height:24px;">';
    let bottomHtml = '<div class="absolute left-0 w-full flex border-b border-gray-300 bg-white" style="top:48px; height:24px;">';
    let heatmapHtml = '<div class="absolute left-0 w-full border-b border-gray-400 bg-white" style="top:72px; height:48px;">';
    
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
        
        if (isWeekView) {
            const nextM = currentM.clone().add(1, 'days');
            if (nextM.day() === 1 || nextM.date() === 1 || d === ganttConfig.totalDays - 1) {
                const width = (d - weekStartDays + 1) * ganttConfig.dayWidth;
                const left = weekStartDays * ganttConfig.dayWidth;
                if (dateOfMonth === 1) currentWeekNum = 1;
                bottomHtml += `<div class="gantt-header-cell ${dayBorder}" style="left:${left}px; width:${width}px; border-left:1px dashed #888;">${currentWeekNum}W</div>`;
                weekStartDays = d + 1;
                currentWeekNum++;
            }
        } else {
            bottomHtml += `<div class="gantt-header-cell ${dayBorder} ${bgClass}" style="left:${d * ganttConfig.dayWidth}px; width:${ganttConfig.dayWidth}px;">${dateOfMonth}</div>`;
        }

        const count = counts[dateStr] || 0;
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
        
        currentM.add(1, 'days');
        
        if (currentM.month() !== currentMonth || d === ganttConfig.totalDays - 1) {
            const width = (d - monthStartDays + 1) * ganttConfig.dayWidth;
            const left = monthStartDays * ganttConfig.dayWidth;
            monthHtml += `<div class="gantt-header-cell gantt-grid-line-month" style="left:${left}px; width:${width}px; font-size:14px;">${currentMonth + 1}月</div>`;
            monthStartDays = d + 1;
            currentMonth = currentM.month();
            if (isWeekView) currentWeekNum = 1;
        }
        
        if (currentM.year() !== currentYear || d === ganttConfig.totalDays - 1) {
            const width = (d - yearStartDays + 1) * ganttConfig.dayWidth;
            const left = yearStartDays * ganttConfig.dayWidth;
            yearHtml += `<div class="gantt-header-cell" style="left:${left}px; width:${width}px; border-left:2px solid #333; font-size:16px;">${currentYear}年</div>`;
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
    // フィルターの取得
    const filterTextElem = document.getElementById('filter-text');
    const filterQuery = filterTextElem && filterTextElem.value.trim() !== '' ? filterTextElem.value.trim().toLowerCase() : '';
    
    // TODO: カスタムの担当者マルチセレクトからの選択値取得
    // 一旦既存の単一選択をサポートしつつ、後で配列対応する
    const filterMemberElem = document.getElementById('filter-member');
    const selectedMembers = window.getSelectedMembers ? window.getSelectedMembers() : (filterMemberElem && filterMemberElem.value ? [filterMemberElem.value] : []);
    
    const filterHideCompletedElem = document.getElementById('filter-hide-completed');
    const hideCompleted = filterHideCompletedElem && filterHideCompletedElem.checked;

    // タスクのフィルタリング
    const filteredTasks = allTasksRaw.filter(t => {
        // 完了済み非表示
        if (hideCompleted && parseInt(t.progress) === 100) return false;
        
        // 担当者フィルター（複数選択）
        if (selectedMembers.length > 0 && !selectedMembers.includes(t.member_id)) return false;
        
        // テキスト検索（全項目部分一致）
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

    const sortedTasks = [...filteredTasks].sort((a, b) => moment(a.start_date).diff(moment(b.start_date)));

    sortedTasks.forEach(t => {
        const lane = t.lane || '1';
        const parentId = `${t.release_id}_${t.char_id}_LANE${lane}`;
        
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
        const memberColor = member ? member.color : '#9ca3af';
        const memberName = member ? member.member_name : '未定';
        const progress = parseInt(t.progress) || 0;
        
        const taskTop = y + (level * (taskHeight + margin)) + (ganttConfig.rowHeight - taskHeight) / 2;
        const completedClass = progress === 100 ? 'completed' : '';
        const selectedClass = (typeof currentTaskContextId !== 'undefined' && currentTaskContextId === t.task_id) ? 'selected' : '';
        
        html += `
            <div class="gantt-task-item ${completedClass} ${selectedClass}" data-task-id="${t.task_id}" style="left:${x}px; top:${taskTop}px; width:${width}px; height:${taskHeight}px; z-index:20;">
                <div class="gantt-task-bg" style="background-color:${bgColor};"></div>
                <div class="gantt-task-progress" style="width:${progress}%; background-color:${bgColor};"></div>
                <div class="gantt-member-badge" style="background-color:${memberColor};">${memberName}</div>
                <div class="gantt-task-name">${t.task_name}</div>
                <div class="gantt-resize-handle gantt-resize-handle-left" data-action="resize-left"></div>
                <div class="gantt-resize-handle gantt-resize-handle-right" data-action="resize-right"></div>
            </div>
        `;
    });

    const parentGroups = ganttConfig.groups.filter(g => g.type === 'release' || g.type === 'character');
    parentGroups.forEach(g => {
        const childTasks = filteredTasks.filter(t => {
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
        else if (g.type === 'character') barClass = 'bg-gray-400 text-black font-bold';

        html += `
            <div class="absolute flex items-center px-2 rounded shadow cursor-pointer ${barClass}" 
                 style="left:${x}px; top:${taskTop}px; width:${width}px; height:${taskHeight}px; z-index:15;"
                 onclick="toggleGroup('${g.id}')">
                <span class="mr-2 text-xs">${icon}</span>
                <span class="truncate" style="font-size:calc(12px * var(--ui-scale, 1));">${g.name}</span>
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

        const charTasks = filteredTasks.filter(t => t.release_id === g.parentId && t.char_id === g.raw.char_id);
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
                const secName = section ? section.section_name : '未定';
                const memName = member ? member.member_name : '未定';
                
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

        const handle = e.target.closest('.gantt-resize-handle');
        const taskEl = e.target.closest('.gantt-task-item');
        
        if (!taskEl) return;
        e.preventDefault(); // タスクのネイティブドラッグも防止
        
        const taskId = taskEl.getAttribute('data-task-id');
        const taskRaw = allTasksRaw.find(t => t.task_id === taskId);
        if (!taskRaw) return;

        dragState.isDragging = true;
        dragState.taskId = taskId;
        dragState.element = taskEl;
        dragState.originalTaskData = JSON.parse(JSON.stringify(taskRaw));
        
        dragState.startX = e.clientX;
        dragState.startY = e.clientY;
        dragState.initialLeft = parseFloat(taskEl.style.left);
        dragState.initialTop = parseFloat(taskEl.style.top);
        dragState.initialWidth = parseFloat(taskEl.style.width);
        
        if (handle) {
            dragState.mode = handle.getAttribute('data-action');
        } else {
            dragState.mode = 'move';
        }
        
        taskEl.style.zIndex = '100';
        document.body.style.cursor = dragState.mode === 'move' ? 'move' : 'ew-resize';
        
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
        
        const dx = e.clientX - dragState.startX;
        const dy = e.clientY - dragState.startY;
        
        if (dragState.mode === 'move') {
            const rawLeft = dragState.initialLeft + dx;
            const rawTop = dragState.initialTop + dy;
            const snappedLeft = Math.round(rawLeft / ganttConfig.dayWidth) * ganttConfig.dayWidth;
            dragState.element.style.left = `${snappedLeft}px`;
            dragState.element.style.top = `${rawTop}px`;
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
            const snappedLeft = Math.round(rawLeft / ganttConfig.dayWidth) * ganttConfig.dayWidth;
            const rightEdge = dragState.initialLeft + dragState.initialWidth;
            const snappedWidth = Math.max(ganttConfig.dayWidth, rightEdge - snappedLeft);
            // 右端を固定して左端を動かすので、左端のスナップ位置に合わせて幅も再計算する
            const actualLeft = rightEdge - snappedWidth;
            dragState.element.style.width = `${snappedWidth}px`;
            dragState.element.style.left = `${actualLeft}px`;
        }
    });

    document.addEventListener('mouseup', (e) => {
        if (panState.isPanning) {
            panState.isPanning = false;
            document.body.style.cursor = '';
            return;
        }

        if (!dragState.isDragging) return;
        
        const dx = Math.abs(e.clientX - dragState.startX);
        const dy = Math.abs(e.clientY - dragState.startY);
        const isClick = (dx < 3 && dy < 3);

        if (isClick) {
            currentTaskContextId = dragState.taskId;
            // renderGantt()でDOMを破壊するとdblclickイベントが発火しなくなるため、手動でクラスを操作する
            document.querySelectorAll('.gantt-task-item').forEach(el => el.classList.remove('selected'));
            if (dragState.element) dragState.element.classList.add('selected');
            
            dragState.isDragging = false;
            dragState.element = null;
            dragState.taskId = null;
            document.body.style.cursor = '';
            return;
        }

        document.body.style.cursor = '';
        
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

        const taskRaw = allTasksRaw.find(t => t.task_id === dragState.taskId);
        
        if (taskRaw) {
            saveHistory();
            
            const finalLeft = parseFloat(dragState.element.style.left);
            const finalWidth = parseFloat(dragState.element.style.width);
            const finalTop = parseFloat(dragState.element.style.top);
            
            const newStartM = xToDate(finalLeft).startOf('day');
            const newEndM = xToDate(finalLeft + finalWidth).subtract(1, 'milliseconds').startOf('day');
            
            taskRaw.start_date = newStartM.format('YYYY-MM-DD');
            taskRaw.end_date = newEndM.format('YYYY-MM-DD');
            
            if (dragState.mode === 'move') {
                const centerTop = finalTop + (24 * ganttConfig.uiScale) / 2;
                const rowIndex = Math.floor(centerTop / ganttConfig.rowHeight);
                if (rowIndex >= 0 && rowIndex < ganttConfig.groups.length) {
                    const targetGroup = ganttConfig.groups[rowIndex];
                    if (targetGroup.type === 'lane') {
                        const parts = targetGroup.id.split('_');
                        if (parts.length >= 4) {
                            taskRaw.release_id = parts[0] + '_' + parts[1];
                            taskRaw.char_id = parts[2] + '_' + parts[3];
                            taskRaw.lane = parts[4] ? parts[4].replace('LANE', '') : '1';
                        }
                    }
                }
            }
            
            markUnsaved();
            renderGantt();
        }
        
        dragState.isDragging = false;
        dragState.element = null;
        dragState.taskId = null;
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
    const editFields = ['edit-release', 'edit-character-name', 'edit-character-costume', 'edit-section', 'edit-task-name', 'edit-member', 'edit-start', 'edit-end', 'edit-progress'];
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
        selM.innerHTML = members.map(m => `<option value="${m.member_id}">${m.member_name}</option>`).join('');
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
            lane: document.getElementById('edit-task-id').value ? (allTasksRaw.find(t=>t.task_id === document.getElementById('edit-task-id').value).lane || '1') : '1'
        };

        const targetIdx = allTasksRaw.findIndex(t => t.task_id === raw.task_id);
        if (targetIdx >= 0) {
            allTasksRaw[targetIdx] = raw;
        } else {
            allTasksRaw.push(raw);
        }

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

    if (filterMemberBtn) {
        filterMemberBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            filterMemberDropdown.classList.toggle('hidden');
            if (!filterMemberDropdown.classList.contains('hidden')) {
                filterMemberSearch.focus();
            }
        });
    }

    if (filterMemberSearch) {
        filterMemberSearch.addEventListener('input', (e) => {
            const term = e.target.value.trim().toLowerCase();
            document.querySelectorAll('.member-filter-item').forEach(item => {
                const cb = item.querySelector('.member-filter-cb');
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
    });

    document.getElementById('filter-hide-completed').addEventListener('change', () => {
        renderGantt();
    });
    
    // els.ganttTasks.addEventListener('dblclick', (e) => {
    // ダブルクリックによるエディタ展開は廃止（コンテキストメニューに移行）
    els.ganttTasks.addEventListener('dblclick', (e) => {
        // 何もしない、または必要であれば他の処理
    });

    els.ganttBody.addEventListener('contextmenu', (e) => {
        e.preventDefault();
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

            contextMenu.style.left = e.pageX + 'px';
            contextMenu.style.top = e.pageY + 'px';
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

        if (e.ctrlKey && e.key === 'c') {
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

init();