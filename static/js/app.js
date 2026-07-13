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
window.addEventListener('unhandledrejection', function(e) {
    serverLog('REJECTION', "Reason: " + e.reason);
});

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

// Copy/Paste State
let copiedTaskRaw = null;
let lastContextGroup = null;
let lastContextTime = null;
let lastMouseGroup = null;
let lastMouseTime = null;

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
    updateParentBars();
    
    if (timeline) {
        timeline.setGroups(groups);
        timeline.setItems(items); // timeline gets the DataView
        timeline.fit();
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
    const tasks = await res.json();
    
    // Parse to vis.js items format
    const parsedItems = tasks.map(t => {
        const lane = t.lane || '1'; // 旧データへのフォールバック
        return {
            id: t.task_id,
            // 自由配置用のレーングループに配置
            group: `${t.release_id}_${t.char_id}_LANE${lane}`,
            // 文字列のままだとUTC判定されて9時間ズレる場合があるため、momentでLocal時間に変換
            start: moment(t.start_date).toDate(),
            // Vis.js上での衝突判定（同じ行に入らない問題）を防ぐため、
            // 終了時間は 翌日 00:00:00 にする。ミリ秒単位の端数はVis.jsの計算を狂わせる。
            end: moment(t.end_date).add(1, 'days').toDate(),
            content: renderItemContent(t),
            title: generateTaskTooltip(t), // ツールチップ用のHTMLを追加
            className: parseInt(t.progress) === 100 ? 'completed' : '',
            raw: t
        };
    });
    // 重複IDエラーでクラッシュするのを防ぐため、addではなくupdateを使用する
    items.update(parsedItems);
}

function generateTaskTooltip(task) {
    const section = getMasterItem('section', 'section_id', task.section_id);
    const member = getMasterItem('member', 'member_id', task.member_id);
    const memberName = member ? member.member_name : '未定';
    const sectionName = section ? section.section_name : '未定';

    // 営業日（工数・人日）の計算
    let manDays = 0;
    const startM = moment(task.start_date).startOf('day');
    const endM = moment(task.end_date).startOf('day');
    
    // start_date から end_date まで（同日含む）ループ
    if (startM.isValid() && endM.isValid()) {
        for (let m = moment(startM); m.isSameOrBefore(endM); m.add(1, 'days')) {
            const dateStr = m.format('YYYY-MM-DD');
            const dayOfWeek = m.day();
            
            let isHoliday = false;
            // マスタに登録されているかチェック
            if (masters.holiday && masters.holiday.find(h => h.holiday_date === dateStr)) {
                isHoliday = true;
            }
            // 日・土チェック
            else if (dayOfWeek === 0 || dayOfWeek === 6) {
                isHoliday = true;
            }
            
            if (!isHoliday) {
                manDays++;
            }
        }
    }

    return `
        <div style="padding: 4px; font-size: 12px; line-height: 1.5;">
            <div style="font-weight: bold; margin-bottom: 4px; border-bottom: 1px solid #ccc; padding-bottom: 2px;">${task.task_name}</div>
            <div>セクション: ${sectionName}</div>
            <div>担当者: ${memberName}</div>
            <div>期間: ${task.start_date} 〜 ${task.end_date}</div>
            <div>進捗: ${task.progress}%</div>
            <div>工数: ${manDays}人日</div>
        </div>
    `;
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
        <div class="custom-item-wrapper">
            <div class="custom-item">
                <div class="member-badge" style="background-color: ${memberColor};">${memberName}</div>
                <div class="bg-layer" style="background-color: ${bgColor};"></div>
                <div class="progress-bg" style="width: ${progress}%; background-color: ${bgColor};"></div>
                <div class="item-content">
                    <span class="task-name">${task.task_name}</span>
                </div>
            </div>
        </div>
    `;
}

function buildGroups() {
    if (!masters.release || !masters.character || !masters.section) return;
    // 階層: Release -> Character -> Lane (上下の自由配置用レーン)
    masters.release.forEach(rel => {
        groups.add({
            id: rel.release_id,
            content: `<b>${rel.release_name}</b>`,
            nestedGroups: [],
            showNested: true,
            treeLevel: 1
        });

        masters.character.forEach(char => {
            const charGroupId = `${rel.release_id}_${char.char_id}`;
            groups.add({
                id: charGroupId,
                content: `${char.char_name} (${char.costume_name})`,
                nestedGroups: [],
                showNested: true,
                treeLevel: 2
            });
            
            // Add char to release's nestedGroups
            const relGroup = groups.get(rel.release_id);
            relGroup.nestedGroups.push(charGroupId);
            groups.update(relGroup);

            // ユーザーが上下に自由に動かせるようにするための抽象レーン（行）
            // 極端なパッキングから滝（ウォーターフォール）配置まで自由に行える
            for (let i = 1; i <= 3; i++) {
                const laneGroupId = `${charGroupId}_LANE${i}`;
                groups.add({
                    id: laneGroupId,
                    content: `Lane ${i}`,
                    treeLevel: 3
                });

                // Add lane group to char's nestedGroups
                const cGroup = groups.get(charGroupId);
                cGroup.nestedGroups.push(laneGroupId);
                groups.update(cGroup);

                // レーンが空の時にVis.jsが内部高さを0にしてしまいドロップ不可になるバグを防ぐため、
                // 不可視のダミーアイテムを配置してレーンの高さを強制的に確保する
                items.add({
                    id: `dummy_${laneGroupId}`,
                    group: laneGroupId,
                    start: '2026-01-01',
                    end: '2027-12-31',
                    type: 'range',
                    content: '',
                    className: 'dummy-lane-item',
                    editable: false
                });
            }
        });
    });
}

// Vis.jsのアイテムエンジンを介さず、直接DOMの背景領域に色を塗る関数
function drawHolidaysDirectly() {
    if (!timeline) return;
    
    // Vis.jsの一番奥底の背景パネル要素を取得
    const backgroundPanel = document.querySelector('.vis-panel.vis-background');
    const centerPanel = document.querySelector('.vis-panel.vis-center'); // テキスト配置用
    if (!backgroundPanel || !centerPanel) return;

    // 前回のカスタム背景をクリア
    backgroundPanel.querySelectorAll('.custom-holiday-bg').forEach(el => el.remove());
    centerPanel.querySelectorAll('.custom-holiday-bg').forEach(el => el.remove());

    // 現在の画面表示範囲を取得し、少し広めに描画する
    const win = timeline.getWindow();
    const start = moment(win.start).subtract(3, 'days').startOf('day');
    const end = moment(win.end).add(3, 'days').startOf('day');

    const filterSectionId = document.getElementById('filter-section') ? document.getElementById('filter-section').value : '';
    const allTasks = items.get({ filter: item => item.raw });

    for (let m = moment(start); m.isBefore(end); m.add(1, 'days')) {
        const dateStr = m.format('YYYY-MM-DD');
        const dayOfWeek = m.day();
        
        let isHoliday = false;
        let className = '';
        
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
        
        const currentDayDate = m.toDate();
        const nextDayDate = m.clone().add(1, 'days').toDate();
        
        const rangeStart = win.start.valueOf();
        const rangeEnd = win.end.valueOf();
        const rangeWidth = rangeEnd - rangeStart;
        const panelWidth = backgroundPanel.clientWidth;
        
        // 時間の比率からピクセルX座標を正確に計算
        const leftX = ((currentDayDate.valueOf() - rangeStart) / rangeWidth) * panelWidth;
        const rightX = ((nextDayDate.valueOf() - rangeStart) / rangeWidth) * panelWidth;
        const width = rightX - leftX;

        // 休日背景の描画
        if (isHoliday) {
            const div = document.createElement('div');
            div.className = `custom-holiday-bg`;
            div.style.position = 'absolute';
            div.style.top = '0';
            div.style.bottom = '0';
            div.style.left = leftX + 'px';
            div.style.width = width + 'px';
            div.style.pointerEvents = 'none'; // 操作の邪魔をさせない
            div.style.zIndex = '0'; // 背景の一番奥
            
            if (className === 'bg-saturday') {
                div.style.backgroundColor = 'rgba(173, 216, 230, 0.4)';
            } else if (className === 'bg-sunday-public') {
                div.style.backgroundColor = 'rgba(255, 182, 193, 0.4)';
            } else if (className === 'bg-company-holiday') {
                div.style.backgroundColor = 'rgba(211, 211, 211, 0.4)';
            }

            backgroundPanel.appendChild(div);
        }

        // 稼働Line数の計算と表示
        let activeLineCount = 0;
        const currentDay = m.clone().startOf('day');
        allTasks.forEach(task => {
            const raw = task.raw;
            if (filterSectionId && raw.section_id !== filterSectionId) return;
            const taskStart = moment(task.start).startOf('day');
            if (currentDay.isSameOrAfter(taskStart) && currentDay.isBefore(moment(task.end))) {
                activeLineCount++;
            }
        });

        if (activeLineCount > 0 && !isHoliday) {
            let heatColor = 'rgba(134, 239, 172, 0.8)'; // 緑
            if (activeLineCount >= 5) {
                heatColor = 'rgba(239, 68, 68, 0.8)'; // 赤
            } else if (activeLineCount >= 3) {
                heatColor = 'rgba(245, 158, 11, 0.8)'; // オレンジ
            }
            if (filterSectionId) {
                heatColor = 'rgba(96, 165, 250, 0.8)'; // 青
            }

            const maxLineHeight = 5; // 5タスクを上限(100%)として高さを計算
            const heightPercent = Math.min((activeLineCount / maxLineHeight) * 100, 100);

            // コンテナ（白背景）
            const containerDiv = document.createElement('div');
            containerDiv.className = 'custom-holiday-bg';
            containerDiv.style.position = 'absolute';
            containerDiv.style.top = '0';
            containerDiv.style.left = leftX + 'px';
            containerDiv.style.width = width + 'px';
            containerDiv.style.height = '32px';
            containerDiv.style.backgroundColor = 'rgba(255, 255, 255, 0.8)';
            containerDiv.style.borderBottom = '1px solid #ddd';
            containerDiv.style.borderRight = '1px solid #eee';
            containerDiv.style.zIndex = '5';
            
            // 棒グラフ部分（下から伸びる）
            const barDiv = document.createElement('div');
            barDiv.style.position = 'absolute';
            barDiv.style.bottom = '0';
            barDiv.style.left = '0';
            barDiv.style.width = '100%';
            barDiv.style.height = `${heightPercent}%`;
            barDiv.style.backgroundColor = heatColor;
            containerDiv.appendChild(barDiv);

            // テキスト部分
            const textDiv = document.createElement('div');
            textDiv.style.position = 'absolute';
            textDiv.style.top = '0';
            textDiv.style.left = '0';
            textDiv.style.width = '100%';
            textDiv.style.height = '100%';
            textDiv.style.lineHeight = '32px';
            textDiv.style.textAlign = 'center';
            textDiv.style.fontSize = '12px';
            textDiv.style.fontWeight = 'bold';
            textDiv.style.color = '#333';
            textDiv.innerText = activeLineCount;
            containerDiv.appendChild(textDiv);

            centerPanel.appendChild(containerDiv);
        }

        // 月の境目の垂直線（太い罫線）: その月の1日の開始位置
        if (m.date() === 1) {
            const line = document.createElement('div');
            line.className = 'custom-holiday-bg custom-month-line';
            line.style.position = 'absolute';
            line.style.top = '0';
            line.style.bottom = '0';
            line.style.left = leftX + 'px';
            line.style.width = '2px';
            line.style.backgroundColor = '#666'; // 太い罫線
            line.style.pointerEvents = 'none';
            line.style.zIndex = '1'; // 休日背景より手前
            backgroundPanel.appendChild(line);
        }
        // 週の境目の垂直線（破線）: 月曜日の開始位置（月の境目と被らない場合のみ）
        else if (dayOfWeek === 1) {
            const line = document.createElement('div');
            line.className = 'custom-holiday-bg custom-week-line';
            line.style.position = 'absolute';
            line.style.top = '0';
            line.style.bottom = '0';
            line.style.left = leftX + 'px';
            line.style.width = '0px';
            line.style.borderLeft = '1px dashed #aaa'; // 破線
            line.style.pointerEvents = 'none';
            line.style.zIndex = '1';
            backgroundPanel.appendChild(line);
        }
    }
}

// （不要になった旧関数。呼び出し元のエラーを防ぐために空で残す）
function buildHolidays() {
    // 廃止。Vis.jsのアイテムエンジンを使用した背景描画はバグの温床となるため使用しない。
}

function updateParentBars() {
    // 既存の親バーを削除
    const existingParentBars = items.get({ filter: item => item.isParentBar });
    items.remove(existingParentBars.map(i => i.id));
    
    const allTasks = items.get({ filter: item => item.raw });
    if (allTasks.length === 0) return;
    
    const parentBars = [];
    
    // 各グループの期間を計算
    const groupBounds = {};
    
    allTasks.forEach(task => {
        const parts = task.group.split('_');
        if (parts.length < 5) return; // R_001_C_001_LANE1
        const releaseId = parts[0] + '_' + parts[1]; // e.g. R_001
        const charGroupId = releaseId + '_' + parts[2] + '_' + parts[3]; // e.g. R_001_C_001
        
        // 開始日・終了日が空文字などで不正な場合はスキップ
        const mStart = moment(task.start);
        const mEnd = moment(task.end);
        if (!mStart.isValid() || !mEnd.isValid()) return;

        // task.start/end は DateオブジェクトなのでそのままgetTime()可能
        const taskStart = task.start.getTime();
        const taskEnd = task.end.getTime();
        
        [releaseId, charGroupId].forEach(gid => {
            if (!groupBounds[gid]) {
                groupBounds[gid] = { start: taskStart, end: taskEnd };
            } else {
                groupBounds[gid].start = Math.min(groupBounds[gid].start, taskStart);
                groupBounds[gid].end = Math.max(groupBounds[gid].end, taskEnd);
            }
        });
    });
    
    // 親バーのアイテムを生成
    Object.keys(groupBounds).forEach(gid => {
        const bounds = groupBounds[gid];
        const groupObj = groups.get(gid);
        if (!groupObj) return;
        
        // もし計算結果が不正なら追加しない
        if (isNaN(bounds.start) || isNaN(bounds.end)) return;
        
        const isCollapsed = groupObj.showNested === false;
        const icon = isCollapsed ? '▶' : '▽';
        // contentからタグを除去してテキストだけにする
        const titleText = groupObj.content.replace(/<[^>]+>/g, '');
        
        // treeLevel が 2 ならキャラクターのバー
        const extraClass = groupObj.treeLevel === 2 ? 'char-group-bar' : '';

        parentBars.push({
            id: 'parent_bar_' + gid,
            group: gid,
            start: new Date(bounds.start),
            end: new Date(bounds.end),
            content: `
                <div class="parent-group-bar ${extraClass}" data-group-id="${gid}">
                    <span class="collapse-icon">${icon}</span>
                    <span class="parent-title">${titleText}</span>
                </div>
            `,
            type: 'range',
            isParentBar: true,
            className: 'vis-parent-bar',
            editable: false // 親バーはドラッグできない
        });
    });
    
    // addではなくupdateを使用する
    items.update(parentBars);
}

function initTimeline() {
    const container = document.getElementById('visualization');
    const options = {
        groupOrder: 'id',
        orientation: 'top', // 日付表示を最上部に
        timeAxis: { scale: 'day', step: 1 }, // 初期は日表示、間引き防止
        format: {
            minorLabels: function (date, scale, step) {
                const m = moment(date);
                const firstDayOfWeek = m.clone().startOf('month').day();
                const monthWeek = Math.ceil((m.date() + firstDayOfWeek) / 7) + 'w';
                
                switch (scale) {
                    case 'day': return m.format('D');
                    case 'week': return monthWeek;
                    case 'month': return m.format('M月');
                    default: return m.format('YYYY');
                }
            },
            majorLabels: function (date, scale, step) {
                const m = moment(date);
                switch (scale) {
                    case 'day': return m.format('YYYY年M月'); // 1wを削除
                    case 'week': return m.format('YYYY年M月');
                    case 'month': return m.format('YYYY年');
                    default: return '';
                }
            }
        },
        editable: {
            add: false,
            updateTime: true,
            updateGroup: true, // 上下のレーン移動を許可
            remove: false
        },
        xss: {
            disabled: true // style属性などがサニタイズされて消えるのを防ぐ
        },
        margin: {
            item: {
                horizontal: 0,
                vertical: 0
            },
            axis: 32 // Line数表示用のスペースを上部に32px確保
        },
        snap: function (date, scale, step) {
            // ドラッグやリサイズ時に0:00固定にする
            return new Date(date.getFullYear(), date.getMonth(), date.getDate());
        },
        stack: true, // テトリス自動配置（レーン別に独立して機能する）
        height: '100%', // 画面下端までガントチャートの背景（グリッド）を描画する
        zoomMin: 1000 * 60 * 60 * 24 * 3, // 3日分程度までに制限（細くなりすぎないように）
        zoomMax: 1000 * 60 * 60 * 24 * 365, // 1年分程度までズームアウト可能に
        onMove: function (item, callback) {
            // 制約: 親キャラクターが異なるグループへの移動は禁止
            const raw = item.raw;
            const oldCharId = `${raw.release_id}_${raw.char_id}`;
            const parts = item.group.split('_');
            const newCharId = `${parts[0]}_${parts[1]}_${parts[2]}_${parts[3]}`; // R_001_C_001
            
            if (newCharId !== oldCharId) {
                // キャラクターが違う場合はグループ移動をキャンセル（時間は反映）
                item.group = `${oldCharId}_LANE${raw.lane || '1'}`;
            } else {
                // 同じキャラクター内ならレーン移動を許可しデータを更新
                const laneMatch = item.group.match(/LANE(\d+)$/);
                if (laneMatch) {
                    raw.lane = laneMatch[1];
                }
            }
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
        if (props.item && !items.get(props.item).isParentBar) {
            openEditor(props.item);
        } else if (props.group && props.time) {
            // New task
            openEditorNew(props.group, props.time);
        }
    });

    timeline.on('select', function (props) {
        // do nothing
    });

    // 描画が更新されるたびに背景を描画し直す
    timeline.on('changed', function() {
        drawHolidaysDirectly();
    });

    timeline.on('click', function (props) {
        // 親バーのクリックで折りたたみをトグルする
        if (props.item) {
            const item = items.get(props.item);
            if (item && item.isParentBar) {
                const groupId = item.group;
                const groupObj = groups.get(groupId);
                if (groupObj) {
                    // showNestedが未定義の場合はtrue扱い。現在trueならfalseに、falseならtrueにする
                    const newShowNested = groupObj.showNested === false ? true : false;
                    groups.update({ id: groupId, showNested: newShowNested });
                    
                    // Vis.jsのデフォルトの折りたたみが左ラベル非表示下でうまく連動しない場合があるため、
                    // 子孫グループの visible を手動でトグルする
                    const childUpdates = [];
                    const toggleChildren = (parentId, visible) => {
                        const parentGroup = groups.get(parentId);
                        if (parentGroup && parentGroup.nestedGroups) {
                            parentGroup.nestedGroups.forEach(childId => {
                                childUpdates.push({ id: childId, visible: visible });
                                // 子グループが展開状態ならその子孫も連動させる
                                const childGroup = groups.get(childId);
                                if (childGroup && childGroup.showNested !== false) {
                                    toggleChildren(childId, visible);
                                }
                            });
                        }
                    };
                    toggleChildren(groupId, newShowNested);
                    if (childUpdates.length > 0) {
                        groups.update(childUpdates);
                    }

                    // アイコンを変えるためにバーを再描画
                    updateParentBars();
                }
            }
        }
    });

    let currentTimeScale = 'day';
    // ズームアウトに応じて、日表示と週表示を強制的に切り替える
    timeline.on('rangechange', function (props) {
        if (!props.byUser) return;
        const range = props.end - props.start;
        // 閾値：限界まで極限まで日表示を維持（約150日分、約5ヶ月幅まで粘る）
        const THRESHOLD = 1000 * 60 * 60 * 24 * 150;
        
        if (range > THRESHOLD && currentTimeScale !== 'week') {
            currentTimeScale = 'week';
            timeline.setOptions({ timeAxis: { scale: 'week', step: 1 } });
        } else if (range <= THRESHOLD && currentTimeScale !== 'day') {
            currentTimeScale = 'day';
            timeline.setOptions({ timeAxis: { scale: 'day', step: 1 } });
        }
    });

    let crosshairTimeId = 'crosshair_time';
    try {
        timeline.addCustomTime(new Date(), crosshairTimeId);
    } catch (e) {
        // すでに存在する場合は無視
    }

    // ツールチップ要素
    let crosshairTooltip = document.getElementById('crosshair-tooltip');
    if (!crosshairTooltip) {
        crosshairTooltip = document.createElement('div');
        crosshairTooltip.id = 'crosshair-tooltip';
        crosshairTooltip.style.position = 'fixed';
        crosshairTooltip.style.backgroundColor = '#2563eb';
        crosshairTooltip.style.color = '#fff';
        crosshairTooltip.style.padding = '4px 8px';
        crosshairTooltip.style.borderRadius = '4px';
        crosshairTooltip.style.fontSize = '12px';
        crosshairTooltip.style.fontWeight = 'bold';
        crosshairTooltip.style.pointerEvents = 'none';
        crosshairTooltip.style.zIndex = '9999';
        crosshairTooltip.style.display = 'none';
        crosshairTooltip.style.transform = 'translate(-50%, -100%)';
        crosshairTooltip.style.marginTop = '-15px';
        crosshairTooltip.style.boxShadow = '0 2px 4px rgba(0,0,0,0.3)';
        document.body.appendChild(crosshairTooltip);
    }

    // Vis.jsの伝播停止を回避するため、documentレベルのキャプチャフェーズで取得する
    document.addEventListener('mousemove', (e) => {
        // Timelineの外側なら非表示にする
        if (!e.target.closest('#visualization')) {
            crosshairTooltip.style.display = 'none';
            return;
        }

        try {
            const props = timeline.getEventProperties(e);
            if (props && props.time) {
                if (props.group) {
                    lastMouseGroup = props.group;
                }
                lastMouseTime = props.time;

                // vis.js標準のカスタムタイムバーをマウスの位置（その日の0時）に移動
                const mDate = moment(props.time).startOf('day');
                try {
                    timeline.setCustomTime(mDate.toDate(), crosshairTimeId);
                } catch (err) {
                    // ignore
                }

                // ツールチップの更新
                const days = ['日', '月', '火', '水', '木', '金', '土'];
                const dayStr = days[mDate.day()];
                crosshairTooltip.innerText = mDate.format('MM/DD') + ` (${dayStr})`;
                
                crosshairTooltip.style.left = e.clientX + 'px';
                crosshairTooltip.style.top = e.clientY + 'px';
                crosshairTooltip.style.display = 'block';
            } else {
                crosshairTooltip.style.display = 'none';
            }
        } catch (err) {
            // 例外時は非表示
            crosshairTooltip.style.display = 'none';
        }
    }, true); // true = capture phase
    
    document.addEventListener('mouseleave', () => {
        crosshairTooltip.style.display = 'none';
    });

    timeline.on('contextmenu', function (props) {
        props.event.preventDefault();
        
        // 常に右クリック位置のグループと時間を保存しておく（ペースト用）
        if (props.group && props.time) {
            lastContextGroup = props.group;
            lastContextTime = props.time;
        }
        
        if (props.item) {
            currentTaskContextId = props.item;
        } else {
            currentTaskContextId = null;
        }
        
        // ペーストはアイテムがなくても可能。コピーや進捗変更はアイテムがある時のみ可能にするが
        // メニューは表示して中で判定・無効化する方が良い
        contextMenu.style.left = props.event.pageX + 'px';
        contextMenu.style.top = props.event.pageY + 'px';
        contextMenu.classList.remove('hidden');
    });

    timeline.on('itemUpdated', function (item) {
        // sync raw data
        const raw = item.raw;
        // update start/end from item (vis.js modifies item.start/end directly)
        raw.start_date = moment(item.start).format('YYYY-MM-DD');
        // ドラッグ後は00:00スナップされるか、元の23:59:59.999のままの可能性があるため、
        // 10ms足して安全に翌日00:00にした後、-1日して正確な終了日を取得する
        raw.end_date = moment(item.end).subtract(1, 'days').format('YYYY-MM-DD');
        item.content = renderItemContent(raw);
        
        item.start = moment(raw.start_date).toDate();
        item.end = moment(raw.end_date).add(1, 'days').toDate();
        
        isUndoRedoAction = true; // prevent double push in update event
        items.update(item);
        isUndoRedoAction = false;
        
        // タスクをドラッグして期間が変わった場合、親バーの期間も追従させる
        updateParentBars();
        
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
    updateParentBars();
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
    updateParentBars();
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
    const filterSectionEl = document.getElementById('filter-section');
    if (filterSectionEl) {
        filterSectionEl.addEventListener('change', () => {
            drawHolidaysDirectly();
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
        // Ctrl+Z, Ctrl+Y
        if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 'z') {
            performUndo();
        } else if (e.ctrlKey && (e.shiftKey && e.key.toLowerCase() === 'z' || e.key.toLowerCase() === 'y')) {
            performRedo();
        }
        // Ctrl+C
        else if (e.ctrlKey && e.key.toLowerCase() === 'c') {
            // 現在選択されているアイテムをコピー
            const selectedIds = timeline.getSelection();
            if (selectedIds && selectedIds.length > 0) {
                const item = items.get(selectedIds[0]);
                if (item && !item.isParentBar && item.raw) {
                    copiedTaskRaw = JSON.parse(JSON.stringify(item.raw));
                    serverLog('DEBUG', "Copied: " + copiedTaskRaw.task_name);
                }
            }
        }
        // Ctrl+V
        else if (e.ctrlKey && e.key.toLowerCase() === 'v') {
            if (copiedTaskRaw && lastMouseGroup && lastMouseTime) {
                pasteTask(lastMouseGroup, lastMouseTime);
            }
        }
        // Delete
        else if (e.key === 'Delete') {
            const selectedIds = timeline.getSelection();
            if (selectedIds && selectedIds.length > 0) {
                const item = items.get(selectedIds[0]);
                if (item && !item.isParentBar && item.raw) {
                    if (confirm('選択中のタスクを削除しますか？')) {
                        saveHistory();
                        items.remove(item.id);
                        updateParentBars();
                        markUnsaved();
                        panel.classList.add('translate-x-full');
                    }
                }
            }
        }
    });

    document.getElementById('ctx-copy').addEventListener('click', () => {
        if (currentTaskContextId) {
            const item = items.get(currentTaskContextId);
            if (item && !item.isParentBar && item.raw) {
                copiedTaskRaw = JSON.parse(JSON.stringify(item.raw));
                serverLog('DEBUG', "Copied from context: " + copiedTaskRaw.task_name);
            }
        }
        contextMenu.classList.add('hidden');
    });

    document.getElementById('ctx-paste').addEventListener('click', () => {
        if (copiedTaskRaw && lastContextGroup && lastContextTime) {
            pasteTask(lastContextGroup, lastContextTime);
        }
        contextMenu.classList.add('hidden');
    });

    document.getElementById('ctx-delete').addEventListener('click', () => {
        if (currentTaskContextId) {
            const item = items.get(currentTaskContextId);
            if (item && !item.isParentBar && item.raw) {
                if (confirm('選択中のタスクを削除しますか？')) {
                    saveHistory();
                    items.remove(item.id);
                    updateParentBars();
                    markUnsaved();
                    panel.classList.add('translate-x-full');
                }
            }
        }
        contextMenu.classList.add('hidden');
    });

    function pasteTask(targetGroup, targetTime) {
        if (!copiedTaskRaw) return;
        
        saveHistory();
        
        const newRaw = JSON.parse(JSON.stringify(copiedTaskRaw));
        // IDは新規発行
        newRaw.task_id = 'TSK_' + Date.now();
        
        // グループ文字列から release, char, lane を抽出
        // e.g. R_001_C_001_LANE1
        const parts = targetGroup.split('_');
        if (parts.length >= 5) {
            newRaw.release_id = parts[0] + '_' + parts[1];
            newRaw.char_id = parts[2] + '_' + parts[3];
            newRaw.lane = parts[4].replace('LANE', '');
        }
        
        // 期間の計算
        const oldStart = moment(copiedTaskRaw.start_date);
        const oldEnd = moment(copiedTaskRaw.end_date);
        const durationDays = oldEnd.diff(oldStart, 'days');
        
        // ペースト先の日付（スナップされたもの）
        const newStart = moment(targetTime).startOf('day');
        newRaw.start_date = newStart.format('YYYY-MM-DD');
        newRaw.end_date = newStart.clone().add(durationDays, 'days').format('YYYY-MM-DD');
        
        const item = {
            id: newRaw.task_id,
            group: targetGroup,
            start: moment(newRaw.start_date).toDate(),
            end: moment(newRaw.end_date).add(1, 'days').subtract(1, 'milliseconds').toDate(),
            content: renderItemContent(newRaw),
            title: generateTaskTooltip(newRaw),
            className: parseInt(newRaw.progress) === 100 ? 'completed' : '',
            raw: newRaw
        };
        
        items.add(item);
        updateParentBars();
        markUnsaved();
    }

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
            progress: document.getElementById('edit-progress').value,
            // 編集対象の元のレーンを維持するか、新規ならレーン1に
            lane: document.getElementById('edit-task-id').value && items.get(document.getElementById('edit-task-id').value) ? items.get(document.getElementById('edit-task-id').value).raw.lane || '1' : '1'
        };

        const item = {
            id: raw.task_id,
            // 自由配置用レーンに配置する
            group: `${raw.release_id}_${raw.char_id}_LANE${raw.lane}`,
            start: moment(raw.start_date).toDate(),
            // Vis.js描画用に+1日して1ミリ秒引く
            end: moment(raw.end_date).add(1, 'days').subtract(1, 'milliseconds').toDate(),
            content: renderItemContent(raw),
            title: generateTaskTooltip(raw),
            className: parseInt(raw.progress) === 100 ? 'completed' : '',
            raw: raw
        };

        if (document.getElementById('edit-task-id').value) {
            items.update(item);
        } else {
            items.add(item);
        }

        updateParentBars();
        markUnsaved();
        panel.classList.add('translate-x-full');
    });

    document.getElementById('btn-delete-task').addEventListener('click', () => {
        const id = document.getElementById('edit-task-id').value;
        if(confirm('本当に削除しますか？')) {
            saveHistory();
            items.remove(id);
            updateParentBars();
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
                item.title = generateTaskTooltip(item.raw);
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

let currentScale = 1.0;

function setupCustomScroll() {
    const container = document.getElementById('visualization');
    if (!container) return;
    
    container.addEventListener('wheel', (e) => {
        // コンテキストメニューやエディタ上では何もしない
        if (e.target.closest('#side-panel') || e.target.closest('#context-menu')) return;
        
        e.preventDefault(); // 画面自体のスクロールを完全無効化
        
        if (e.ctrlKey) {
            // CTRL + マウスホイールでUI全体の拡縮
            e.stopPropagation();
            if (e.deltaY < 0) {
                currentScale = Math.min(currentScale + 0.05, 2.0);
            } else {
                currentScale = Math.max(currentScale - 0.05, 0.4);
            }
            document.documentElement.style.setProperty('--ui-scale', currentScale);
            if (timeline) {
                timeline.redraw();
            }
        } else {
            // 単純ホイールでVis.jsの日付ズームを強制発動する
            e.stopPropagation();
            const zoomFactor = e.deltaY > 0 ? 1.2 : 0.8; // 縮小/拡大
            
            // 現在のウィンドウ情報を取得
            const win = timeline.getWindow();
            const start = win.start.getTime();
            const end = win.end.getTime();
            const range = end - start;
            
            // マウス位置を中心にズームする計算
            const rect = container.getBoundingClientRect();
            // 左メニューが非表示なのでマウスのX座標はそのままコンテナ内の相対位置
            const mouseX = e.clientX - rect.left;
            const ratio = mouseX / rect.width;
            
            const mouseTime = start + range * ratio;
            
            let newRange = range * zoomFactor;
            // zoomMin/Maxの制約をマニュアル適用
            const minRange = 1000 * 60 * 60 * 24 * 3;
            const maxRange = 1000 * 60 * 60 * 24 * 365;
            newRange = Math.max(minRange, Math.min(maxRange, newRange));
            
            const newStart = mouseTime - newRange * ratio;
            const newEnd = mouseTime + newRange * (1 - ratio);
            
            timeline.setWindow(newStart, newEnd, { animation: false });
        }
    }, { passive: false });
}

function formatDate(date) {
    return date.toISOString().split('T')[0];
}

init().then(setupCustomScroll);