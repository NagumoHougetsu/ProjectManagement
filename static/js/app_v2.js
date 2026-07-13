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

let masters = {};
let allTasksRaw = [];
let currentProject = 'Sample';
let hasUnsavedChanges = false;
const unsavedBadge = document.getElementById('unsaved-badge');

// Undo/Redo State
let historyStack = [];
let redoStack = [];
let isUndoRedoAction = false;
let copiedTaskRaw = null;

async function init() {
    await fetchProjects();
    await reloadData();
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

async function fetchMasters() {
    const res = await fetch(`/api/masters?project=${currentProject}`);
    masters = await res.json();
    
    if (masters.section) {
        const filterSel = document.getElementById('filter-section');
        if (filterSel) {
            const currentVal = filterSel.value;
            filterSel.innerHTML = '<option value="">全セクション表示</option>' +
                masters.section.map(s => `<option value="${s.section_id}">${s.section_name}</option>`).join('');
            if (Array.from(filterSel.options).some(o => o.value === currentVal)) {
                filterSel.value = currentVal;
            }
        }
    }
}

async function fetchTasks() {
    const res = await fetch(`/api/tasks?project=${currentProject}`);
    allTasksRaw = await res.json();
}

function getMasterItem(type, idField, id) {
    if (!masters[type]) return null;
    return masters[type].find(m => m[idField] === id);
}

function markUnsaved() {
    hasUnsavedChanges = true;
    unsavedBadge.classList.remove('hidden');
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

async function reloadData() {
    historyStack = [];
    redoStack = [];
    updateUndoRedoButtons();
    await fetchMasters();
    await fetchTasks();
    
    initDhtmlxGantt();
    renderGantt();
}

function initDhtmlxGantt() {
    gantt.config.scale_height = 50;
    gantt.config.row_height = 36;
    gantt.config.task_height = 24;
    gantt.config.round_dnd_dates = false;
    gantt.config.drag_progress = false; // 右ドラッグでの進捗変更オフ
    gantt.config.drag_links = false; // 依存関係オフ
    gantt.config.details_on_dblclick = false; // デフォルトエディタオフ

    // 日本語化設定（エラー回避のため一旦コメントアウト、もしくは正しく適用）
    // gantt.i18n.setLocale("jp");

    // データの日付フォーマットを指定
    gantt.config.date_format = "%Y-%m-%d";

    // 日付フォーマット（年・月・日の3段）
    gantt.config.scales = [
        {unit: "year", step: 1, format: "%Y年"},
        {unit: "month", step: 1, format: "%n月"},
        {unit: "day", step: 1, format: "%d"}
    ];

    // 左のグリッド（ツリー）を完全に隠す
    gantt.config.show_grid = false;

    // プラグインの有効化（GPL版の場合組み込み）
    gantt.plugins({
        tooltip: true,
        marker: true,
        drag_timeline: true
    });

    // ドラッグでの上下左右移動（パン）設定
    gantt.config.drag_timeline = {
        ignore: ".gantt_task_line, .gantt_task_link",
        useKey: false
    };

    // 描画期間を広めに確保する（前後1年ずつなど）
    const today = new Date();
    gantt.config.start_date = new Date(today.getFullYear() - 1, today.getMonth(), 1);
    gantt.config.end_date = new Date(today.getFullYear() + 2, today.getMonth(), 1);

    // 休日・罫線ハイライト用のクラス追加
    gantt.templates.timeline_cell_class = function(task, date){
        let classes = [];
        const m = moment(date);
        const dateStr = m.format('YYYY-MM-DD');
        const dayOfWeek = m.day();
        const dateOfMonth = m.date();
        
        const masterHoliday = masters.holiday ? masters.holiday.find(h => h.holiday_date === dateStr) : null;
        
        if (masterHoliday) {
            classes.push(masterHoliday.holiday_type === 'public' ? 'bg-sunday-public' : 'bg-company-holiday');
        } else if (dayOfWeek === 0) {
            classes.push('bg-sunday-public');
        } else if (dayOfWeek === 6) {
            classes.push('bg-saturday');
        }

        // 罫線（カレンダーのスケール単位が日の場合のみ有効にするか、週の場合も1日が来るたびに太線）
        if (dateOfMonth === 1) {
            classes.push('month-border');
        } else if (dayOfWeek === 1) { // 月曜日
            classes.push('week-border');
        }

        return classes.join(" ");
    };

    gantt.templates.scale_cell_class = function(date){
        let classes = [];
        const dayOfWeek = moment(date).day();
        const dateOfMonth = moment(date).date();
        if (dateOfMonth === 1) {
            classes.push('month-border');
        } else if (dayOfWeek === 1) {
            classes.push('week-border');
        }
        return classes.join(" ");
    };

    // タスクバーのカスタムHTML
    gantt.templates.task_text = function(start, end, task){
        if (task.type === 'project') return task.text;
        
        const raw = task.raw;
        const section = getMasterItem('section', 'section_id', raw.section_id);
        const member = getMasterItem('member', 'member_id', raw.member_id);
        const memberColor = member ? member.color : '#9ca3af';
        const memberName = member ? member.member_name : '未定';
        
        return `
            <div class="member-badge" style="background-color: ${memberColor};">${memberName}</div>
            <span class="task-name-text">${task.text}</span>
        `;
    };

    // タスクバーの色付け
    gantt.templates.task_class = function(start, end, task){
        let cls = "";
        if (task.type === 'project') {
            if (task.level === 1) cls = "char-group-bar";
            return cls;
        }
        if (task.progress === 1) cls += " completed";
        return cls;
    };

    // タスクバー自体のスタイル（背景色など）
    gantt.config.task_class = "gantt_task_line";

    gantt.attachEvent("onBeforeTaskDisplay", function(id, task){
        // セクションフィルタリング
        const filterSectionId = document.getElementById('filter-section') ? document.getElementById('filter-section').value : '';
        if (filterSectionId && task.type !== 'project') {
            if (task.raw && task.raw.section_id !== filterSectionId) return false;
        }
        return true;
    });

    // イベントフック（移動時）
    gantt.attachEvent("onAfterTaskDrag", function(id, mode, e){
        saveHistory();
        const task = gantt.getTask(id);
        if (task.type !== 'project' && task.raw) {
            // rawデータの更新
            task.raw.start_date = moment(task.start_date).format('YYYY-MM-DD');
            // DHTMLXの仕様では duration が日数、end_date は翌日00:00なので
            task.raw.end_date = moment(task.end_date).subtract(1, 'days').format('YYYY-MM-DD');
            // 所属親が変わっていたらLaneを変更
            if (task.parent) {
                const laneMatch = task.parent.match(/LANE(\d+)$/);
                if (laneMatch) {
                    task.raw.lane = laneMatch[1];
                }
            }
            // AllTasksRaw内の該当要素を更新
            const targetIdx = allTasksRaw.findIndex(t => t.task_id === id);
            if (targetIdx >= 0) {
                allTasksRaw[targetIdx] = task.raw;
            }
        }
        markUnsaved();
    });

    // ダブルクリックで自作エディタを開く
    gantt.attachEvent("onTaskDblClick", function(id, e){
        const task = gantt.getTask(id);
        if (task.type !== 'project') {
            openEditor(id);
        } else if (task.id.includes('LANE')) {
            // レーンをダブルクリックしたらその時間で新規作成
            const time = gantt.getTaskPosition(task, e.clientX).x;
            const date = gantt.dateFromPos(e.clientX - gantt.config.grid_width);
            openEditorNew(task.id, date);
        }
        return false; // デフォルトエディタは開かない
    });

    // 背景にカスタムDOMを追加するためのイベント
    gantt.attachEvent("onGanttReady", function(){
        // DHTMLXではカスタム背景を動的に描画するのはやや複雑だが、
        // timeline_cell_class で色だけは変えられる。今回は簡略化のためヒートマップは一旦非表示。
    });

    // 初期化は1回だけ
    if (!gantt.$init_done) {
        gantt.init("visualization");
        gantt.$init_done = true;
    }
}

function renderGantt() {
    const data = [];
    const addedProjects = new Set();

    // グループ（プロジェクト）の自動生成
    if (masters.release && masters.character) {
        masters.release.forEach(rel => {
            data.push({ id: rel.release_id, text: rel.release_name, type: "project", open: true, level: 0 });
            
            masters.character.forEach(char => {
                const charGroupId = `${rel.release_id}_${char.char_id}`;
                data.push({ id: charGroupId, text: `${char.char_name} (${char.costume_name})`, parent: rel.release_id, type: "project", open: true, level: 1 });
                
                // 自由配置レーン（3本）
                for (let i = 1; i <= 3; i++) {
                    const laneGroupId = `${charGroupId}_LANE${i}`;
                    data.push({ id: laneGroupId, text: `Lane ${i}`, parent: charGroupId, type: "project", open: true, level: 2 });
                }
            });
        });
    }

    // タスクデータの追加
    allTasksRaw.forEach(t => {
        const lane = t.lane || '1';
        const parentId = `${t.release_id}_${t.char_id}_LANE${lane}`;
        const section = getMasterItem('section', 'section_id', t.section_id);
        
        data.push({
            id: t.task_id,
            text: t.task_name,
            start_date: moment(t.start_date).format('YYYY-MM-DD'),
            // DHTMLXのend_dateは1日加算した日（排他的終了日）
            end_date: moment(t.end_date).add(1, 'days').format('YYYY-MM-DD'),
            parent: parentId,
            progress: parseInt(t.progress) / 100,
            color: section ? section.color : '#3b82f6',
            raw: t
        });
    });

    gantt.clearAll();
    gantt.parse({ data: data, links: [] });
    
    // 現在のズームスケール等を反映したい場合は設定
    // drawHolidaysDirectly(); DHTMLXではテンプレートで行うため不要
}

// Editor, Events Setup etc.
function setupEventListeners() {
    const filterSectionEl = document.getElementById('filter-section');
    if (filterSectionEl) {
        filterSectionEl.addEventListener('change', () => {
            gantt.render(); // 再描画でonBeforeTaskDisplayが走る
        });
    }

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
        const mLink = document.querySelector('a[href^="/master_editor"]');
        mLink.href = `/master_editor?project=${currentProject}`;
    });

    document.getElementById('btn-close-panel').addEventListener('click', () => {
        document.getElementById('side-panel').classList.add('translate-x-full');
    });

    // --- エディタ関連のイベント設定は app.js の既存ロジックを流用 ---
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

    // キーボードショートカット
    document.addEventListener('keydown', (e) => {
        if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 'z') {
            performUndo();
        } else if (e.ctrlKey && (e.shiftKey && e.key.toLowerCase() === 'z' || e.key.toLowerCase() === 'y')) {
            performRedo();
        }
    });

    // マウス追従ハイライト
    let crosshairCol = document.getElementById('crosshair-col');
    if (!crosshairCol) {
        crosshairCol = document.createElement('div');
        crosshairCol.id = 'crosshair-col';
        crosshairCol.className = 'crosshair-marker';
        crosshairCol.style.position = 'fixed';
        crosshairCol.style.top = '0';
        crosshairCol.style.bottom = '0';
        crosshairCol.style.display = 'none';
        document.body.appendChild(crosshairCol);
    }

    // Vis.jsの伝播停止を回避するため、documentレベルのキャプチャフェーズで取得する
    document.addEventListener('mousemove', (e) => {
        // Timelineの外側なら非表示にする
        if (!e.target.closest('.gantt_task')) {
            crosshairCol.style.display = 'none';
            return;
        }

        try {
            // 座標から時間を取得
            const taskArea = document.querySelector('.gantt_task');
            if (!taskArea) return;
            
            const rect = taskArea.getBoundingClientRect();
            // マウスのX座標（スクロール等も考慮されるGantt内部座標）
            const ganttMouseX = gantt.utils.dom.getRelativeEventPosition(e, gantt.$task_data).x;
            const date = gantt.dateFromPos(ganttMouseX);
            
            if (date) {
                const mDate = moment(date).startOf('day');
                const nextDate = mDate.clone().add(1, 'days');
                
                // X座標を計算し直す
                const startX = gantt.posFromDate(mDate.toDate()) + rect.left - gantt.getScrollState().x;
                const endX = gantt.posFromDate(nextDate.toDate()) + rect.left - gantt.getScrollState().x;
                
                crosshairCol.style.left = startX + 'px';
                crosshairCol.style.width = (endX - startX) + 'px';
                crosshairCol.style.display = 'block';
            } else {
                crosshairCol.style.display = 'none';
            }
        } catch (err) {
            // 例外時は非表示
            crosshairCol.style.display = 'none';
        }
    }, true); // true = capture phase
    
    document.addEventListener('mouseleave', () => {
        crosshairCol.style.display = 'none';
    });
}

function openEditor(taskId) {
    const raw = allTasksRaw.find(t => t.task_id === taskId);
    if (!raw) return;
    populateDropdowns();
    
    document.getElementById('edit-task-id').value = raw.task_id;
    document.getElementById('edit-release').value = raw.release_id;
    document.getElementById('edit-character').value = raw.char_id;
    document.getElementById('edit-section').value = raw.section_id;
    
    document.getElementById('edit-section').dispatchEvent(new Event('change'));
    
    document.getElementById('edit-task-name').value = raw.task_name;
    document.getElementById('edit-member').value = raw.member_id;
    document.getElementById('edit-start').value = raw.start_date;
    document.getElementById('edit-end').value = raw.end_date;
    document.getElementById('edit-progress').value = raw.progress;

    document.getElementById('btn-delete-task').classList.remove('hidden');
    document.getElementById('editor-title').textContent = 'タスク編集';
    document.getElementById('side-panel').classList.remove('translate-x-full');
}

function openEditorNew(groupId, dateObj) {
    populateDropdowns();
    document.getElementById('edit-task-id').value = '';
    const dateStr = moment(dateObj).format('YYYY-MM-DD');
    document.getElementById('edit-start').value = dateStr;
    document.getElementById('edit-end').value = dateStr;
    document.getElementById('edit-progress').value = 0;
    
    // groupId からデフォルト設定
    const parts = groupId.split('_');
    if (parts.length >= 4) {
        document.getElementById('edit-release').value = parts[0] + '_' + parts[1];
        document.getElementById('edit-character').value = parts[2] + '_' + parts[3];
    }
    
    document.getElementById('btn-delete-task').classList.add('hidden');
    document.getElementById('editor-title').textContent = '新規タスク作成';
    document.getElementById('side-panel').classList.remove('translate-x-full');
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
}

let currentScale = 1.0;
let zoomLevel = 1; // 0: week, 1: day

function setupCustomScroll() {
    // dhtmlxは .gantt_task 内部などにスクロールがあるため、
    // windowレベルのキャプチャでホイールイベントをすべて横取りして、縦スクロールを防ぐ
    window.addEventListener('wheel', (e) => {
        const container = document.getElementById('visualization');
        if (!container) return;
        
        // ガントチャートのエリア外なら無視
        if (!e.target.closest('#visualization')) return;
        
        // サイドパネル上のスクロールなら通常通り通す
        if (e.target.closest('#side-panel') || e.target.closest('#context-menu')) return;
        
        // ガントチャート上のホイールはブラウザ本来のスクロールを100%無効化する
        e.preventDefault();
        e.stopPropagation();
        
        if (e.ctrlKey) {
            // CTRL + マウスホイールで縦幅（行の高さ）の拡縮
            if (e.deltaY < 0) {
                currentScale = Math.min(currentScale + 0.1, 2.0);
            } else {
                currentScale = Math.max(currentScale - 0.1, 0.4);
            }
            document.documentElement.style.setProperty('--ui-scale', currentScale);
            gantt.config.row_height = 36 * currentScale;
            gantt.config.task_height = 24 * currentScale;
            gantt.render();
        } else {
            // 単純ホイールで日付ズーム（横幅の拡縮とスケール切り替え）
            const zoomFactor = e.deltaY < 0 ? 1.2 : 0.8;
            let currentWidth = gantt.config.min_column_width;
            let newWidth = currentWidth * zoomFactor;
            
            // ズーム中心を維持するための事前計算
            const mouseX = e.clientX - container.getBoundingClientRect().left;
            const scrollState = gantt.getScrollState();
            const dateAtMouse = gantt.dateFromPos(scrollState.x + mouseX - gantt.config.grid_width);

            // スケール（日表示 ⇔ 週表示）の切り替え判定
            if (zoomLevel === 1) { // 日表示
                if (newWidth < 20 && e.deltaY > 0) {
                    // 極限まで縮小したら週表示に切り替え
                    zoomLevel = 0;
                    gantt.config.scales = [
                        {unit: "year", step: 1, format: "%Y年"},
                        {unit: "month", step: 1, format: "%n月"},
                        {
                            unit: "week", step: 1, format: function(date) {
                                // dateは週の開始日。週の過半数（+3日した木曜日）が属する月を基準にする
                                const targetDate = moment(date).add(3, 'days');
                                // その月の1日から数えて何週目かを単純計算（1〜7日が1W, 8〜14日が2W...）
                                const weekOfMonth = Math.ceil(targetDate.date() / 7);
                                return weekOfMonth + "W";
                            }
                        }
                    ];
                    newWidth = 100; // 週表示でのデフォルト幅
                } else {
                    newWidth = Math.min(200, newWidth);
                }
            } else if (zoomLevel === 0) { // 週表示
                if (newWidth > 150 && e.deltaY < 0) {
                    // 極限まで拡大したら日表示に切り替え
                    zoomLevel = 1;
                    gantt.config.scales = [
                        {unit: "year", step: 1, format: "%Y年"},
                        {unit: "month", step: 1, format: "%n月"},
                        {unit: "day", step: 1, format: "%d"}
                    ];
                    newWidth = 20; // 日表示でのデフォルト幅
                } else {
                    newWidth = Math.max(20, newWidth);
                }
            }
            
            gantt.config.min_column_width = newWidth;
            gantt.render();
            
            // ズーム後の日付が同じマウス位置に来るようにスクロール位置を再調整
            if (dateAtMouse) {
                const newPos = gantt.posFromDate(dateAtMouse);
                gantt.scrollTo(newPos - mouseX + gantt.config.grid_width, scrollState.y);
            }
        }
    }, { passive: false, capture: true });
}

init().then(setupCustomScroll);