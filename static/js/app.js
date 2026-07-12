let timeline;
let items = new vis.DataSet();
let groups = new vis.DataSet();

let masters = {};
let hasUnsavedChanges = false;
let currentTaskContextId = null;
let currentProject = 'Sample';

// Undo/Redo State
let historyStack = [];
let redoStack = [];
let isUndoRedoAction = false;

// DOM Elements
const panel = document.getElementById('side-panel');
const unsavedBadge = document.getElementById('unsaved-badge');
const contextMenu = document.getElementById('context-menu');

// Initialize
async function init() {
    await fetchProjects();
    await reloadData();
    initTimeline();
    setupEventListeners();
}

async function fetchProjects() {
    const res = await fetch('/api/projects');
    const projects = await res.json();
    const sel = document.getElementById('project-select');
    sel.innerHTML = projects.map(p => `<option value="${p}">${p}</option>`).join('');
    if (projects.length > 0) {
        currentProject = projects[0];
        sel.value = currentProject;
    }
}

async function reloadData() {
    masters = {};
    items.clear();
    groups.clear();
    historyStack = [];
    redoStack = [];
    updateUndoRedoButtons();
    
    await fetchMasters();
    await fetchTasks();
    buildGroups();
    buildHolidays();
    
    if (timeline) {
        timeline.setGroups(groups);
        timeline.setItems(items);
        timeline.fit();
    }
}

async function fetchMasters() {
    const res = await fetch(`/api/masters?project=${currentProject}`);
    masters = await res.json();
}

async function fetchTasks() {
    const res = await fetch(`/api/tasks?project=${currentProject}`);
    const tasks = await res.json();
    
    // Parse to vis.js items format
    const parsedItems = tasks.map(t => {
        return {
            id: t.task_id,
            group: `${t.release_id}_${t.char_id}_${t.section_id}`,
            start: t.start_date,
            end: t.end_date,
            content: renderItemContent(t),
            className: parseInt(t.progress) === 100 ? 'completed' : '',
            // store raw data
            raw: t
        };
    });
    items.add(parsedItems);
}

function getMasterItem(type, idField, id) {
    if (!masters[type]) return null;
    return masters[type].find(m => m[idField] === id);
}

function renderItemContent(task) {
    const section = getMasterItem('section', 'section_id', task.section_id);
    const member = getMasterItem('member', 'member_id', task.member_id);
    const bgColor = section ? section.color : '#3b82f6';
    const memberColor = member ? member.color : '#9ca3af';
    const memberName = member ? member.member_name : '未定';
    const progress = parseInt(task.progress) || 0;

    return `
        <div class="custom-item" style="background-color: ${bgColor};">
            <div class="progress-bg" style="width: ${progress}%;"></div>
            <div class="item-content">
                <span class="member-badge" style="background-color: ${memberColor};">${memberName}</span>
                <span class="task-name">${task.task_name} (${progress}%)</span>
            </div>
        </div>
    `;
}

function buildGroups() {
    if (!masters.release || !masters.character || !masters.section) return;
    // 階層: Release -> Character -> Section
    masters.release.forEach(rel => {
        groups.add({
            id: rel.release_id,
            content: `<b>${rel.release_name}</b>`,
            nestedGroups: [],
            treeLevel: 1
        });

        masters.character.forEach(char => {
            const charGroupId = `${rel.release_id}_${char.char_id}`;
            groups.add({
                id: charGroupId,
                content: `${char.char_name} (${char.costume_name})`,
                nestedGroups: [],
                treeLevel: 2
            });
            
            // Add char to release's nestedGroups
            const relGroup = groups.get(rel.release_id);
            relGroup.nestedGroups.push(charGroupId);
            groups.update(relGroup);

            masters.section.forEach(sec => {
                const secGroupId = `${charGroupId}_${sec.section_id}`;
                groups.add({
                    id: secGroupId,
                    content: sec.section_name,
                    treeLevel: 3
                });

                // Add sec to char's nestedGroups
                const cGroup = groups.get(charGroupId);
                cGroup.nestedGroups.push(secGroupId);
                groups.update(cGroup);
            });
        });
    });
}

function buildHolidays() {
    // Generate background items for holidays/weekends for a range (e.g., year 2026-2027)
    const startDate = moment('2026-01-01');
    const endDate = moment('2027-12-31');
    
    let holidayItems = [];
    let bgId = 0;
    
    for (let m = moment(startDate); m.isBefore(endDate); m.add(1, 'days')) {
        const dateStr = m.format('YYYY-MM-DD');
        const dayOfWeek = m.day(); // 0: Sun, 6: Sat
        
        let isHoliday = false;
        let className = '';
        
        // 1. マスタチェック
        const masterHoliday = masters.holiday ? masters.holiday.find(h => h.holiday_date === dateStr) : null;
        
        if (masterHoliday) {
            isHoliday = true;
            className = masterHoliday.holiday_type === 'public' ? 'bg-sunday-public' : 'bg-company-holiday';
        } else if (dayOfWeek === 0) {
            isHoliday = true;
            className = 'bg-sunday-public';
        } else if (dayOfWeek === 6) {
            isHoliday = true;
            className = 'bg-saturday';
        }
        
        // 平日も白で強制的に塗りつぶす（Vis.jsの謎のピンク背景を隠蔽する）
        if (!isHoliday || className === '') {
            className = 'bg-weekday';
        }
        
        holidayItems.push({
            id: 'bg_' + (bgId++),
            start: m.clone().startOf('day').toDate(),
            end: m.clone().add(1, 'days').startOf('day').toDate(),
            type: 'background',
            className: className
        });
    }
    
    items.add(holidayItems);
}

function initTimeline() {
    const container = document.getElementById('visualization');
    const options = {
        groupOrder: 'id',
        orientation: 'top', // 日付表示を最上部に
        format: {
            minorLabels: {
                day: 'D',
                week: 'w[W]',    // 週表示 (例: 1W)
                month: 'MMM',
                year: 'YYYY'
            },
            majorLabels: {
                day: 'YYYY年 M月',
                week: 'YYYY年 M月',
                month: 'YYYY年',
                year: ''
            }
        },
        editable: {
            add: false,
            updateTime: true,
            updateGroup: false,
            remove: false
        },
        xss: {
            disabled: true // style属性などがサニタイズされて消えるのを防ぐ
        },
        snap: function (date, scale, step) {
            // ドラッグやリサイズ時に0:00固定にする
            return new Date(date.getFullYear(), date.getMonth(), date.getDate());
        },
        stack: true, // テトリス配置
        margin: {
            item: {
                horizontal: 0,
                vertical: 2 // 行間を密接させる
            },
            axis: 2
        },
        zoomMin: 1000 * 60 * 60 * 24 * 7, // 1週間分。これ以上縮小すると1,3,5表示になるためストップさせる
        zoomMax: 1000 * 60 * 60 * 24 * 30 * 12, // 1 year
        zoomKey: '', // デフォルトのまま（修飾キーなしで横方向のズーム）
        onMove: function (item, callback) {
            saveHistory();
            callback(item);
        },
        onRemove: function (item, callback) {
            saveHistory();
            callback(item);
        }
    };

    timeline = new vis.Timeline(container, items, groups, options);

    // Events
    timeline.on('doubleClick', function (props) {
        if (props.item) {
            openEditor(props.item);
        } else if (props.group && props.time) {
            // New task
            openEditorNew(props.group, props.time);
        }
    });

    timeline.on('contextmenu', function (props) {
        props.event.preventDefault();
        if (props.item) {
            currentTaskContextId = props.item;
            contextMenu.style.left = props.event.pageX + 'px';
            contextMenu.style.top = props.event.pageY + 'px';
            contextMenu.classList.remove('hidden');
        }
    });

    timeline.on('itemUpdated', function (item) {
        // sync raw data
        const raw = item.raw;
        // update start/end from item (vis.js modifies item.start/end directly)
        raw.start_date = moment(item.start).format('YYYY-MM-DD');
        raw.end_date = moment(item.end).format('YYYY-MM-DD');
        item.content = renderItemContent(raw);
        
        isUndoRedoAction = true; // prevent double push in update event
        items.update(item);
        isUndoRedoAction = false;
        
        markUnsaved();
    });

}

function saveHistory() {
    if (isUndoRedoAction) return;
    // bg_アイテムを除外して保存
    const currentState = items.get().filter(i => i.type !== 'background').map(i => JSON.parse(JSON.stringify(i)));
    historyStack.push(currentState);
    // keep stack size reasonable
    if (historyStack.length > 50) historyStack.shift();
    redoStack = [];
    updateUndoRedoButtons();
}

function performUndo() {
    if (historyStack.length === 0) return;
    isUndoRedoAction = true;
    
    // 現在の状態をredoに積む
    redoStack.push(items.get().filter(i => i.type !== 'background').map(i => JSON.parse(JSON.stringify(i))));
    
    const prevState = historyStack.pop();
    // 背景アイテムは残す
    const bgs = items.get().filter(i => i.type === 'background');
    items.clear();
    items.add(bgs);
    items.add(prevState);
    
    isUndoRedoAction = false;
    updateUndoRedoButtons();
    markUnsaved();
}

function performRedo() {
    if (redoStack.length === 0) return;
    isUndoRedoAction = true;
    
    // 現在の状態をhistoryに積む
    historyStack.push(items.get().filter(i => i.type !== 'background').map(i => JSON.parse(JSON.stringify(i))));
    
    const nextState = redoStack.pop();
    // 背景アイテムは残す
    const bgs = items.get().filter(i => i.type === 'background');
    items.clear();
    items.add(bgs);
    items.add(nextState);
    
    isUndoRedoAction = false;
    updateUndoRedoButtons();
    markUnsaved();
}

function updateUndoRedoButtons() {
    const btnUndo = document.getElementById('btn-undo');
    const btnRedo = document.getElementById('btn-redo');
    if(btnUndo) btnUndo.disabled = historyStack.length === 0;
    if(btnRedo) btnRedo.disabled = redoStack.length === 0;
}

document.addEventListener('click', (e) => {
    if (!e.target.closest('#context-menu')) {
        contextMenu.classList.add('hidden');
    }
});

function markUnsaved() {
    hasUnsavedChanges = true;
    unsavedBadge.classList.remove('hidden');
}

// Side Panel Logic
function openEditor(itemId) {
    const item = items.get(itemId);
    const raw = item.raw;
    populateDropdowns();
    
    document.getElementById('edit-task-id').value = raw.task_id;
    document.getElementById('edit-release').value = raw.release_id;
    document.getElementById('edit-character').value = raw.char_id;
    document.getElementById('edit-section').value = raw.section_id;
    
    // trigger change to filter members/templates
    document.getElementById('edit-section').dispatchEvent(new Event('change'));
    
    document.getElementById('edit-task-name').value = raw.task_name;
    document.getElementById('edit-member').value = raw.member_id;
    document.getElementById('edit-start').value = raw.start_date;
    document.getElementById('edit-end').value = raw.end_date;
    document.getElementById('edit-progress').value = raw.progress;

    document.getElementById('btn-delete-task').classList.remove('hidden');
    document.getElementById('editor-title').textContent = 'タスク編集';
    
    panel.classList.remove('translate-x-full');
}

function openEditorNew(groupId, time) {
    populateDropdowns();
    // parse groupId (Release_Char_Section)
    const parts = groupId.split('_');
    if (parts.length >= 3) {
        const release_id = parts[0] + '_' + parts[1]; // Release ID is R_001
        // wait, split by '_' is tricky if ID has '_'
        // lets find from groups
    }
    // Simplification: just reset
    document.getElementById('edit-task-id').value = '';
    const dateStr = time.toISOString().split('T')[0];
    document.getElementById('edit-start').value = dateStr;
    document.getElementById('edit-progress').value = 0;
    
    document.getElementById('btn-delete-task').classList.add('hidden');
    document.getElementById('editor-title').textContent = '新規タスク作成';
    
    panel.classList.remove('translate-x-full');
}

function populateDropdowns() {
    const renderOptions = (data, idField, nameField, selectId) => {
        const sel = document.getElementById(selectId);
        sel.innerHTML = '<option value="">選択してください</option>' + 
            data.map(d => `<option value="${d[idField]}">${d[nameField]}</option>`).join('');
    };

    renderOptions(masters.release, 'release_id', 'release_name', 'edit-release');
    renderOptions(masters.character, 'char_id', 'char_name', 'edit-character');
    renderOptions(masters.section, 'section_id', 'section_name', 'edit-section');
    
    // members and tasks are filtered by section
}

function setupEventListeners() {
    document.getElementById('project-select').addEventListener('change', async (e) => {
        if (hasUnsavedChanges) {
            if (!confirm('未保存の変更がありますが、プロジェクトを切り替えますか？')) {
                e.target.value = currentProject;
                return;
            }
        }
        currentProject = e.target.value;
        hasUnsavedChanges = false;
        unsavedBadge.classList.add('hidden');
        await reloadData();
        
        // update master editor link
        const mLink = document.querySelector('a[href^="/master_editor"]');
        mLink.href = `/master_editor?project=${currentProject}`;
    });

    document.getElementById('btn-close-panel').addEventListener('click', () => {
        panel.classList.add('translate-x-full');
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

    document.addEventListener('keydown', (e) => {
        if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 'z') {
            performUndo();
        } else if (e.ctrlKey && (e.shiftKey && e.key.toLowerCase() === 'z' || e.key.toLowerCase() === 'y')) {
            performRedo();
        }
    });

    document.getElementById('btn-apply-task').addEventListener('click', () => {
        saveHistory();
        const raw = {
            task_id: document.getElementById('edit-task-id').value || 'TSK_' + Date.now(),
            release_id: document.getElementById('edit-release').value,
            char_id: document.getElementById('edit-character').value,
            section_id: document.getElementById('edit-section').value,
            task_name: document.getElementById('edit-task-name').value, // wait, this is select, but user might want custom? We map select value.
            member_id: document.getElementById('edit-member').value,
            start_date: document.getElementById('edit-start').value,
            end_date: document.getElementById('edit-end').value,
            progress: document.getElementById('edit-progress').value
        };

        const item = {
            id: raw.task_id,
            group: `${raw.release_id}_${raw.char_id}_${raw.section_id}`,
            start: raw.start_date,
            end: raw.end_date,
            content: renderItemContent(raw),
            className: parseInt(raw.progress) === 100 ? 'completed' : '',
            raw: raw
        };

        if (document.getElementById('edit-task-id').value) {
            items.update(item);
        } else {
            items.add(item);
        }

        markUnsaved();
        panel.classList.add('translate-x-full');
    });

    document.getElementById('btn-delete-task').addEventListener('click', () => {
        const id = document.getElementById('edit-task-id').value;
        if(confirm('本当に削除しますか？')) {
            saveHistory();
            items.remove(id);
            markUnsaved();
            panel.classList.add('translate-x-full');
        }
    });

    document.querySelectorAll('.context-progress').forEach(el => {
        el.addEventListener('click', (e) => {
            if (currentTaskContextId) {
                saveHistory();
                const prog = e.target.getAttribute('data-progress');
                const item = items.get(currentTaskContextId);
                item.raw.progress = prog;
                item.content = renderItemContent(item.raw);
                item.className = parseInt(prog) === 100 ? 'completed' : '';
                items.update(item);
                markUnsaved();
                contextMenu.classList.add('hidden');
            }
        });
    });

    document.getElementById('btn-save').addEventListener('click', async () => {
        const tasksToSave = items.get().filter(i => i.raw).map(i => i.raw);
        try {
            const res = await fetch(`/api/tasks/save?project=${currentProject}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(tasksToSave)
            });
            const result = await res.json();
            if (result.status === 'success') {
                hasUnsavedChanges = false;
                unsavedBadge.classList.add('hidden');
                alert('保存が完了しました。');
            } else {
                alert('エラー: ' + result.message);
            }
        } catch(e) {
            alert('保存に失敗しました。');
        }
    });
}

let currentBarHeight = 24;

function setupCustomScroll() {
    const container = document.getElementById('visualization');
    if (!container) return;
    
    // CTRL + マウスホイールで行（バー）の高さ調整
    container.addEventListener('wheel', (e) => {
        if (e.ctrlKey) {
            e.preventDefault(); // ブラウザのズームを無効化
            e.stopPropagation(); // Vis.jsのズームを無効化
            
            // 上スクロールで拡大、下スクロールで縮小
            if (e.deltaY < 0) {
                currentBarHeight = Math.min(currentBarHeight + 2, 60);
            } else {
                currentBarHeight = Math.max(currentBarHeight - 2, 5); // 限界まで細くできるように
            }
            document.documentElement.style.setProperty('--bar-height', currentBarHeight + 'px');
            
            // Timelineの再描画を促してテトリス配置を更新する
            if (timeline) {
                // marginオプションを再セットすることでVis.jsに高さの再計算を強制する
                timeline.setOptions({ margin: { item: { horizontal: 0, vertical: 2 }, axis: 2 } });
            }
        }
    }, { passive: false, capture: true });
}

// simple script to include moment (vis.js relies on moment implicitly or native Date, we should add moment if missing, but let's use native Date formatting for itemUpdated)
function formatDate(date) {
    return date.toISOString().split('T')[0];
}

init().then(setupCustomScroll);