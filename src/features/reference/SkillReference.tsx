import { BookOpen, CircleDot, Search, Shield, Sparkles, Swords, X } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { ROLE_CATALOG } from '../../../shared/gamePromptContract.js';
import { characters } from '../../domain/catalog/characters';
import { defaultSkillByCharacterId, witchSkillDefinitions } from '../../domain/catalog/witchSkills';
import type { Alignment, SkillTiming, WitchSkillDefinition } from '../../domain/model';
import brandMark from '../../assets/icon.ico';
import styles from './SkillReference.module.css';

const factions = {
  good: { label: '好人', goal: '所有狼人出局。', icon: Shield },
  wolf: { label: '狼队', goal: '存活狼人数不少于存活好人数。', icon: Swords },
  neutral: { label: '中立', goal: '满足该职业的独立胜利条件。', icon: CircleDot },
} satisfies Record<Alignment, unknown>;

const timingNames: Record<SkillTiming, string> = {
  'night-start': '夜间', 'night-protection': '夜间保护', 'on-death': '死亡时',
  'day-start': '白天开始', 'before-speech': '发言前', 'after-speech': '发言期间',
  'on-mention': '被提及时', 'before-vote': '投票前', 'after-vote': '票型公布后', 'after-runoff': '平票重投后',
};
const usageNames: Record<WitchSkillDefinition['usage'], string> = {
  once: '整局一次', nightly: '每夜一次', daily: '每天一次', passive: '被动触发',
};
const magicEntries = Object.values(witchSkillDefinitions).map((skill) => ({
  ...skill,
  owner: characters.find((character) => defaultSkillByCharacterId[character.id] === skill.id),
}));
type Tab = 'roles' | 'magic';

export function SkillReference({ onClose }: { onClose(): void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [tab, setTab] = useState<Tab>('roles');
  const [query, setQuery] = useState('');
  const [faction, setFaction] = useState('all');
  const [usage, setUsage] = useState('all');

  useEffect(() => {
    const dialog = dialogRef.current;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    dialog?.showModal();
    document.body.style.overflow = 'hidden';
    return () => {
      dialog?.close();
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus();
    };
  }, []);

  useEffect(() => { contentRef.current?.scrollTo(0, 0); }, [tab, query, faction, usage]);

  const selectTab = (next: Tab) => { setTab(next); setQuery(''); };
  const handleTabKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 'roles' : event.key === 'End' ? 'magic' : tab === 'roles' ? 'magic' : 'roles';
    selectTab(next);
    document.getElementById(`reference-tab-${next}`)?.focus();
  };
  const search = query.trim().toLocaleLowerCase();
  const roles = ROLE_CATALOG.filter((role) => (faction === 'all' || role.alignment === faction)
    && `${role.name} ${role.description} ${factions[role.alignment].label}`.toLocaleLowerCase().includes(search));
  const magic = magicEntries.filter((skill) => (usage === 'all' || skill.usage === usage)
    && `${skill.name} ${skill.description} ${skill.owner?.name ?? ''} ${skill.timings.map((timing) => timingNames[timing]).join(' ')} ${usageNames[skill.usage]}`.toLocaleLowerCase().includes(search));
  const count = tab === 'roles' ? roles.length : magic.length;

  return <dialog ref={dialogRef} className={styles.dialog} aria-labelledby="reference-title"
    onCancel={(event) => { event.preventDefault(); onClose(); }}
    onClick={(event) => {
      if (event.target !== event.currentTarget) return;
      const bounds = event.currentTarget.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) onClose();
    }}>
    <div className={styles.frame}>
      <header className={styles.header}>
        <img src={brandMark} alt="" />
        <div><h2 id="reference-title">职业与魔法图鉴</h2><p>基础职业决定阵营与职业能力，少女身份决定初始魔女技。</p></div>
        <button type="button" className={styles.close} onClick={onClose} aria-label="关闭图鉴" title="关闭图鉴"><X /></button>
      </header>
      <div className={styles.toolbar}>
        <div className={styles.tabs} role="tablist" aria-label="图鉴分类">
          <button type="button" role="tab" id="reference-tab-roles" aria-controls="reference-panel-roles" aria-selected={tab === 'roles'} tabIndex={tab === 'roles' ? 0 : -1} onKeyDown={handleTabKey} onClick={() => selectTab('roles')}><BookOpen />基础职业 <small>{ROLE_CATALOG.length}</small></button>
          <button type="button" role="tab" id="reference-tab-magic" aria-controls="reference-panel-magic" aria-selected={tab === 'magic'} tabIndex={tab === 'magic' ? 0 : -1} onKeyDown={handleTabKey} onClick={() => selectTab('magic')}><Sparkles />魔女技 <small>{magicEntries.length}</small></button>
        </div>
        <div className={styles.filters}>
          <label className={styles.search}><Search /><input type="search" aria-label="搜索图鉴" placeholder={tab === 'roles' ? '搜索职业或技能效果' : '搜索魔法、少女或技能效果'} value={query} onChange={(event) => setQuery(event.target.value)} /></label>
          {tab === 'roles'
            ? <select aria-label="筛选阵营" value={faction} onChange={(event) => setFaction(event.target.value)}><option value="all">全部阵营</option>{Object.entries(factions).map(([id, entry]) => <option key={id} value={id}>{entry.label}</option>)}</select>
            : <select aria-label="筛选使用次数" value={usage} onChange={(event) => setUsage(event.target.value)}><option value="all">全部次数</option>{Object.entries(usageNames).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select>}
        </div>
      </div>
      <div ref={contentRef} className={styles.content}>
        <div className={styles.summary}><p>{tab === 'roles' ? '职业与魔女技独立分配；同一位少女可以拥有不同职业。' : '以下为初始魔女技归属；交换或回收后，以对局中的当前状态为准。'}</p><span role="status">{count} 项</span></div>
        <section id="reference-panel-roles" role="tabpanel" aria-labelledby="reference-tab-roles" tabIndex={0} hidden={tab !== 'roles'}>
          <div className={styles.grid}>{roles.map((role) => {
            const entry = factions[role.alignment];
            const Icon = entry.icon;
            return <article key={role.id} className={styles.card} data-faction={role.alignment} aria-labelledby={`reference-role-${role.id}`}>
              <header className={styles.cardHeader}><div className={styles.roleIcon}><Icon /></div><h3 id={`reference-role-${role.id}`}>{role.name}</h3><span className={styles.faction}>{entry.label}</span></header>
              <p className={styles.description}>{role.description}</p>
              <p className={styles.goal}><strong>胜利条件</strong>{role.id === 'dodo' ? '白天被放逐，独自获胜。' : entry.goal}</p>
            </article>;
          })}</div>
        </section>
        <section id="reference-panel-magic" role="tabpanel" aria-labelledby="reference-tab-magic" tabIndex={0} hidden={tab !== 'magic'}>
          <div className={styles.grid}>{magic.map((skill) => <article key={skill.id} className={`${styles.card} ${styles.magicCard}`} aria-labelledby={`reference-skill-${skill.id}`}>
            <header className={styles.cardHeader}>{skill.owner && <img className={styles.portrait} src={skill.owner.avatarUrl} alt={skill.owner.name} loading="lazy" />}<div><h3 id={`reference-skill-${skill.id}`}>{skill.name}</h3><p className={styles.owner}>初始持有者 · {skill.owner?.name ?? '无固定持有者'}</p></div></header>
            <dl className={styles.facts}><div><dt>发动时机</dt><dd>{skill.timings.map((timing) => timingNames[timing]).join(' / ')}</dd></div><div><dt>使用次数</dt><dd>{usageNames[skill.usage]}</dd></div></dl>
            <p className={styles.description}>{skill.description}</p>
          </article>)}</div>
        </section>
        {count === 0 && <p className={styles.empty}>没有匹配的条目。</p>}
      </div>
    </div>
  </dialog>;
}
