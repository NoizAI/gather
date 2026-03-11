import { useState, useRef, useCallback } from 'react';
import { useTheme } from '../contexts/ThemeContext';
import { useProjects } from '../contexts/ProjectContext';
import { useLanguage } from '../i18n/LanguageContext';
import { Project, Episode, PROJECT_STAGES, ProjectStage, ProjectSpec } from '../types';
import { ArrowLeft, Plus, Edit2, Trash2, MoreVertical, CheckCircle2, Circle, FileText, Check, X, Download, Headphones, ChevronDown, Users, Music, Calendar, Play, Pause } from 'lucide-react';
import { StageIconMap } from './icons/ReligionIcons';
import * as api from '../services/api';

interface ProjectDetailProps {
  project: Project;
  onBack: () => void;
  onEditEpisode: (episode: Episode) => void;
  onCreateEpisode: () => void;
}

export function ProjectDetail({ project, onBack, onEditEpisode, onCreateEpisode }: ProjectDetailProps) {
  const { theme } = useTheme();
  const { deleteEpisode, updateEpisode, updateProject } = useProjects();
  const { t, language } = useLanguage();
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
  const [stageDropdownId, setStageDropdownId] = useState<string | null>(null);
  const [expandedEpisodeId, setExpandedEpisodeId] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playingEpisodeId, setPlayingEpisodeId] = useState<string | null>(null);
  const inlineAudioRef = useRef<HTMLAudioElement | null>(null);

  const handleTogglePlay = useCallback((e: React.MouseEvent, episode: Episode) => {
    e.stopPropagation();
    if (!episode.audioData || !episode.audioMimeType) return;

    if (playingEpisodeId === episode.id && inlineAudioRef.current) {
      inlineAudioRef.current.pause();
      inlineAudioRef.current = null;
      setPlayingEpisodeId(null);
      return;
    }

    if (inlineAudioRef.current) {
      inlineAudioRef.current.pause();
      inlineAudioRef.current = null;
    }

    const audio = new Audio(api.audioDataToUrl(episode.audioData, episode.audioMimeType));
    audio.addEventListener('ended', () => {
      setPlayingEpisodeId(null);
      inlineAudioRef.current = null;
    });
    audio.play();
    inlineAudioRef.current = audio;
    setPlayingEpisodeId(episode.id);
  }, [playingEpisodeId]);

  const formatDuration = (ms: number): string => {
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  };

  const handleDownloadAudio = (episode: Episode) => {
    if (episode.audioData && episode.audioMimeType) {
      const filename = `${episode.title || 'audio'}.wav`;
      api.downloadAudio(episode.audioData, episode.audioMimeType, filename);
    }
  };

  // Spec editing state
  const [isEditingSpec, setIsEditingSpec] = useState(false);
  const [editSpec, setEditSpec] = useState<ProjectSpec>({
    targetAudience: '',
    formatAndDuration: '',
    toneAndExpression: '',
    addBgm: false,
    addSoundEffects: false,
    hasVisualContent: false,
  });

  const handleStartEditSpec = () => {
    setEditSpec(project.spec ?? {
      targetAudience: '',
      formatAndDuration: '',
      toneAndExpression: '',
      addBgm: false,
      addSoundEffects: false,
      hasVisualContent: false,
    });
    setIsEditingSpec(true);
  };

  const handleSaveSpec = () => {
    updateProject({ ...project, spec: editSpec });
    setIsEditingSpec(false);
  };

  const handleCancelEditSpec = () => {
    setIsEditingSpec(false);
  };

  const handleDeleteEpisode = (episodeId: string) => {
    if (window.confirm(t.projectList.deleteConfirm)) deleteEpisode(project.id, episodeId);
    setMenuOpenId(null);
  };

  const handleEpisodeStageChange = (episode: Episode, newStage: ProjectStage) => {
    updateEpisode(project.id, { ...episode, stage: newStage });
    setStageDropdownId(null);
  };

  const stopAllAudio = () => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    if (inlineAudioRef.current) {
      inlineAudioRef.current.pause();
      inlineAudioRef.current = null;
    }
    setPlayingEpisodeId(null);
  };

  const toggleEpisodeExpand = (episodeId: string) => {
    stopAllAudio();
    if (expandedEpisodeId === episodeId) {
      setExpandedEpisodeId(null);
    } else {
      setExpandedEpisodeId(episodeId);
    }
  };

  const labelBgm = language === 'zh' ? '背景音乐' : language === 'es' ? 'BGM' : 'BGM';
  const labelSfx = language === 'zh' ? '音效' : language === 'es' ? 'SFX' : 'SFX';
  const labelVisual = language === 'zh' ? '视觉' : language === 'es' ? 'Visual' : 'Visual';

  return (
    <div className="space-y-4 md:space-y-6 animate-fade-in">
      {/* Header — consolidated title, metadata, and tags */}
      <div className="flex items-start gap-3 md:gap-4">
        <button onClick={onBack} className="p-1.5 md:p-2 rounded-lg hover:bg-t-card-hover transition-colors flex-shrink-0 mt-1">
          <ArrowLeft size={20} className="md:hidden text-t-text2" />
          <ArrowLeft size={24} className="hidden md:block text-t-text2" />
        </button>
        <div className="flex-1 min-w-0">
          <h1 className="text-xl sm:text-2xl md:text-3xl font-serif font-light text-t-text1 tracking-wide">{project.title}</h1>
          {project.subtitle && <p className="text-t-text2 mt-0.5 text-sm md:text-base italic">{project.subtitle}</p>}

          {/* Compact metadata row */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-2 text-xs text-t-text3">
            <span className="flex items-center gap-1">
              <Calendar size={11} />
              {new Date(project.createdAt).toLocaleDateString()}
            </span>
            <span className="text-t-text3">·</span>
            <span>{project.episodes.length} {t.dashboard.episodes}</span>
            {project.tags.length > 0 && (
              <>
                <span className="text-t-text3">·</span>
                <div className="flex flex-wrap gap-1">
                  {project.tags.map((tag, i) => (
                    <span key={i} className="px-1.5 py-0.5 rounded text-[10px] md:text-xs" style={{ background: `${theme.primary}20`, color: theme.primaryLight }}>
                      {tag}
                    </span>
                  ))}
                </div>
              </>
            )}
          </div>

          {/* Description (only if different from spec fields) */}
          {project.description && project.description !== project.spec?.targetAudience && (
            <p className="text-t-text3 mt-2 text-sm line-clamp-2">{project.description}</p>
          )}
        </div>
      </div>

      {/* Project Spec — compact chip layout in view mode */}
      {(project.spec || isEditingSpec) && (
        <div className="rounded-xl md:rounded-2xl p-4 md:p-5 border border-t-border" style={{ background: 'var(--t-bg-card)' }}>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm md:text-base font-medium text-t-text2">{t.projectDetail.projectSpec}</h2>
            {isEditingSpec ? (
              <div className="flex items-center gap-2">
                <button onClick={handleCancelEditSpec} className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs text-t-text3 hover:text-t-text1 hover:bg-t-card-hover transition-colors">
                  <X size={13} />
                  {language === 'zh' ? '取消' : language === 'es' ? 'Cancelar' : 'Cancel'}
                </button>
                <button onClick={handleSaveSpec} className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium text-t-text1 transition-all hover:scale-105" style={{ background: theme.primary }}>
                  <Check size={13} />
                  {language === 'zh' ? '保存' : language === 'es' ? 'Guardar' : 'Save'}
                </button>
              </div>
            ) : (
              <button onClick={handleStartEditSpec} className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs text-t-text3 hover:text-t-text1 hover:bg-t-card-hover transition-colors">
                <Edit2 size={12} />
                {language === 'zh' ? '编辑' : language === 'es' ? 'Editar' : 'Edit'}
              </button>
            )}
          </div>

          {isEditingSpec ? (
            <div className="space-y-4">
              <div>
                <label className="text-xs text-t-text3 block mb-1">{t.projectDetail.audience}</label>
                <input
                  type="text"
                  value={editSpec.targetAudience}
                  onChange={(e) => setEditSpec({ ...editSpec, targetAudience: e.target.value })}
                  className="w-full px-3 py-2 rounded-lg text-sm text-t-text1 border border-t-border focus:border-t-border outline-none transition-colors"
                  style={{ background: `${theme.primary}10` }}
                />
              </div>
              <div>
                <label className="text-xs text-t-text3 block mb-1">{t.projectDetail.format}</label>
                <input
                  type="text"
                  value={editSpec.formatAndDuration}
                  onChange={(e) => setEditSpec({ ...editSpec, formatAndDuration: e.target.value })}
                  className="w-full px-3 py-2 rounded-lg text-sm text-t-text1 border border-t-border focus:border-t-border outline-none transition-colors"
                  style={{ background: `${theme.primary}10` }}
                />
              </div>
              <div>
                <label className="text-xs text-t-text3 block mb-1">{t.projectDetail.tone}</label>
                <input
                  type="text"
                  value={editSpec.toneAndExpression}
                  onChange={(e) => setEditSpec({ ...editSpec, toneAndExpression: e.target.value })}
                  className="w-full px-3 py-2 rounded-lg text-sm text-t-text1 border border-t-border focus:border-t-border outline-none transition-colors"
                  style={{ background: `${theme.primary}10` }}
                />
              </div>
              <div className="flex flex-wrap gap-4 pt-1">
                <label className="flex items-center gap-2 cursor-pointer text-xs text-t-text2">
                  <input type="checkbox" checked={editSpec.addBgm} onChange={(e) => setEditSpec({ ...editSpec, addBgm: e.target.checked })} className="rounded" style={{ accentColor: theme.primary }} />
                  {language === 'zh' ? '背景音乐' : language === 'es' ? 'Música de fondo' : 'Background Music'}
                </label>
                <label className="flex items-center gap-2 cursor-pointer text-xs text-t-text2">
                  <input type="checkbox" checked={editSpec.addSoundEffects} onChange={(e) => setEditSpec({ ...editSpec, addSoundEffects: e.target.checked })} className="rounded" style={{ accentColor: theme.primary }} />
                  {language === 'zh' ? '音效' : language === 'es' ? 'Efectos de sonido' : 'Sound Effects'}
                </label>
                <label className="flex items-center gap-2 cursor-pointer text-xs text-t-text2">
                  <input type="checkbox" checked={editSpec.hasVisualContent} onChange={(e) => setEditSpec({ ...editSpec, hasVisualContent: e.target.checked })} className="rounded" style={{ accentColor: theme.primary }} />
                  {language === 'zh' ? '视觉内容' : language === 'es' ? 'Contenido visual' : 'Visual Content'}
                </label>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap gap-2 text-xs">
              {project.spec?.targetAudience && (
                <span className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-t-border-lt" style={{ background: `${theme.primary}08` }}>
                  <span className="text-t-text3">{t.projectDetail.audience}</span>
                  <span className="text-t-text2">{project.spec.targetAudience}</span>
                </span>
              )}
              {project.spec?.formatAndDuration && (
                <span className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-t-border-lt" style={{ background: `${theme.primary}08` }}>
                  <span className="text-t-text3">{t.projectDetail.format}</span>
                  <span className="text-t-text2">{project.spec.formatAndDuration}</span>
                </span>
              )}
              {project.spec?.toneAndExpression && (
                <span className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-t-border-lt" style={{ background: `${theme.primary}08` }}>
                  <span className="text-t-text3">{t.projectDetail.tone}</span>
                  <span className="text-t-text2">{project.spec.toneAndExpression}</span>
                </span>
              )}
              {/* Feature flags as small badges */}
              {(project.spec?.addBgm || project.spec?.addSoundEffects || project.spec?.hasVisualContent) && (
                <div className="flex items-center gap-1.5 ml-1">
                  {project.spec?.addBgm && (
                    <span className="px-2 py-1 rounded-md text-[10px] md:text-xs font-medium" style={{ background: `${theme.accent}20`, color: theme.accent }}>{labelBgm}</span>
                  )}
                  {project.spec?.addSoundEffects && (
                    <span className="px-2 py-1 rounded-md text-[10px] md:text-xs font-medium" style={{ background: `${theme.accent}20`, color: theme.accent }}>{labelSfx}</span>
                  )}
                  {project.spec?.hasVisualContent && (
                    <span className="px-2 py-1 rounded-md text-[10px] md:text-xs font-medium" style={{ background: `${theme.accent}20`, color: theme.accent }}>{labelVisual}</span>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Episodes — enhanced with expandable resource previews */}
      <div className="rounded-xl md:rounded-2xl p-4 md:p-6 border border-t-border" style={{ background: 'var(--t-bg-card)' }}>
        <div className="flex items-center justify-between mb-4 md:mb-5 gap-3">
          <h2 className="text-base md:text-lg font-serif text-t-text1">{t.projectDetail.episodeList}</h2>
          <button
            onClick={onCreateEpisode}
            className="flex items-center gap-1.5 md:gap-2 px-3 md:px-4 py-1.5 md:py-2 rounded-lg md:rounded-xl text-xs md:text-sm font-medium transition-all hover:scale-105 flex-shrink-0"
            style={{ background: theme.accent, color: theme.primaryDark }}
          >
            <Plus size={16} />
            <span className="hidden sm:inline">{t.projectDetail.addEpisode}</span>
            <span className="sm:hidden">{t.projectDetail.addShort}</span>
          </button>
        </div>

        {project.episodes.length > 0 ? (
          <div className="space-y-2 md:space-y-3">
            {project.episodes.map((episode, index) => {
              const episodeStage = PROJECT_STAGES.find((s) => s.id === episode.stage);
              const stageT = episodeStage ? t.stages[episodeStage.id] : null;
              const StageIcon = episodeStage ? StageIconMap[episodeStage.id] : null;

              const hasAudio = !!(episode.audioData && episode.audioMimeType);
              const hasScript = !!(episode.scriptSections && episode.scriptSections.length > 0);
              const hasCharacters = !!(episode.characters && episode.characters.length > 0);
              const isExpanded = expandedEpisodeId === episode.id;

              const totalLines = hasScript
                ? episode.scriptSections!.reduce((acc, s) => acc + s.timeline.reduce((a, tl) => a + tl.lines.length, 0), 0)
                : 0;

              return (
                <div key={episode.id} className="rounded-lg md:rounded-xl border border-t-border-lt hover:border-t-border transition-all" style={{ background: `${theme.primary}05` }}>
                  {/* Episode header row */}
                  <div className="flex items-center gap-2 md:gap-3 p-3 md:p-4">
                    {/* Number badge */}
                    <div className="w-8 h-8 md:w-10 md:h-10 rounded-lg md:rounded-xl flex items-center justify-center font-medium text-t-text1 flex-shrink-0 text-sm md:text-base" style={{ background: theme.primary }}>
                      {index + 1}
                    </div>

                    {/* Title + resource summary — clickable to expand */}
                    <button className="flex-1 min-w-0 text-left" onClick={() => toggleEpisodeExpand(episode.id)}>
                      <h3 className="font-medium text-t-text1 truncate text-sm md:text-base">{episode.title}</h3>
                      {/* Resource indicator badges */}
                      <div className="flex flex-wrap items-center gap-2 mt-1">
                        {hasScript && (
                          <span className="flex items-center gap-1 text-[10px] md:text-xs text-t-text3">
                            <FileText size={10} />
                            {episode.scriptSections!.length} {language === 'zh' ? '段' : 'sec'} · {totalLines} {language === 'zh' ? '行' : 'lines'}
                          </span>
                        )}
                        {hasCharacters && (
                          <span className="flex items-center gap-1 text-[10px] md:text-xs text-t-text3">
                            <Users size={10} />
                            {episode.characters!.length}
                          </span>
                        )}
                        {hasAudio && (
                          <span className="flex items-center gap-1 text-[10px] md:text-xs text-t-text3">
                            <Music size={10} />
                            {episode.audioDurationMs ? formatDuration(episode.audioDurationMs) : (language === 'zh' ? '音频' : 'Audio')}
                          </span>
                        )}
                        {!hasScript && !hasCharacters && !hasAudio && (
                          <span className="text-[10px] md:text-xs text-t-text3 italic">
                            {language === 'zh' ? '暂无资源' : language === 'es' ? 'Sin recursos' : 'No resources yet'}
                          </span>
                        )}
                      </div>
                    </button>

                    {/* Inline play/pause button */}
                    {hasAudio && (
                      <button
                        onClick={(e) => handleTogglePlay(e, episode)}
                        className="w-8 h-8 md:w-9 md:h-9 rounded-lg flex items-center justify-center flex-shrink-0 transition-all hover:scale-110"
                        style={{ background: `${theme.primary}20` }}
                        title={playingEpisodeId === episode.id ? (language === 'zh' ? '暂停' : 'Pause') : (language === 'zh' ? '播放' : 'Play')}
                      >
                        {playingEpisodeId === episode.id
                          ? <Pause size={14} color={theme.primaryLight} />
                          : <Play size={14} color={theme.primaryLight} style={{ marginLeft: 1 }} />
                        }
                      </button>
                    )}

                    {/* Expand/collapse chevron */}
                    <button
                      onClick={() => toggleEpisodeExpand(episode.id)}
                      className="p-1 rounded-md hover:bg-t-card-hover transition-colors flex-shrink-0"
                    >
                      <ChevronDown size={16} className={`text-t-text3 transition-transform duration-200 ${isExpanded ? 'rotate-180' : ''}`} />
                    </button>

                    {/* Stage badge — clickable dropdown */}
                    <div className="relative hidden sm:block flex-shrink-0">
                      <button
                        onClick={() => setStageDropdownId(stageDropdownId === episode.id ? null : episode.id)}
                        className="flex items-center gap-1.5 px-2 md:px-3 py-1 md:py-1.5 rounded-md md:rounded-lg text-[10px] md:text-xs transition-colors hover:opacity-80 cursor-pointer"
                        style={{
                          background: episode.stage === 'review'
                            ? `${theme.accent}30`
                            : episode.stage === 'published'
                              ? '#22c55e20'
                              : `${theme.primary}20`,
                          color: episode.stage === 'review'
                            ? theme.accent
                            : episode.stage === 'published'
                              ? '#4ade80'
                              : theme.primaryLight
                        }}
                      >
                        {StageIcon && <StageIcon size={12} color="currentColor" />}
                        {episode.stage === 'review'
                          ? (language === 'zh' ? '待发布' : 'Ready')
                          : stageT?.name}
                      </button>
                      {stageDropdownId === episode.id && (
                        <div className="absolute right-0 top-full mt-1 rounded-xl border border-t-border py-1 z-10 min-w-[140px] md:min-w-[160px] backdrop-blur-xl" style={{ background: 'var(--t-bg-base)' }}>
                          {PROJECT_STAGES.map((stage) => {
                            const stageItemT = t.stages[stage.id];
                            const StageItemIcon = StageIconMap[stage.id];
                            return (
                              <button
                                key={stage.id}
                                onClick={() => { handleEpisodeStageChange(episode, stage.id); setStageDropdownId(null); }}
                                className="w-full px-3 md:px-4 py-1.5 md:py-2 text-left text-xs md:text-sm text-t-text2 hover:text-t-text1 hover:bg-t-card flex items-center gap-2"
                              >
                                {episode.stage === stage.id ? <CheckCircle2 size={14} style={{ color: theme.primary }} /> : <Circle size={14} className="text-t-text3" />}
                                <StageItemIcon size={12} color="currentColor" />
                                {stageItemT.name}
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>

                    {/* More menu */}
                    <div className="relative flex-shrink-0">
                      <button onClick={() => setMenuOpenId(menuOpenId === episode.id ? null : episode.id)} className="p-1.5 md:p-2 hover:bg-t-card-hover rounded-lg transition-colors">
                        <MoreVertical size={16} className="md:hidden text-t-text3" />
                        <MoreVertical size={18} className="hidden md:block text-t-text3" />
                      </button>
                      {menuOpenId === episode.id && (
                        <div className="absolute right-0 top-full mt-1 rounded-xl border border-t-border py-1 z-10 min-w-[140px] md:min-w-[160px] backdrop-blur-xl" style={{ background: 'var(--t-bg-base)' }}>
                          <button onClick={() => { onEditEpisode(episode); setMenuOpenId(null); }} className="w-full px-3 md:px-4 py-2 text-left text-xs md:text-sm text-t-text2 hover:text-t-text1 hover:bg-t-card flex items-center gap-2">
                            <Edit2 size={14} />{t.projectDetail.editContent}
                          </button>
                          <div className="border-t border-t-border my-1" />
                          <button onClick={() => handleDeleteEpisode(episode.id)} className="w-full px-3 md:px-4 py-1.5 md:py-2 text-left text-xs md:text-sm text-red-400 hover:bg-red-500/10 flex items-center gap-2">
                            <Trash2 size={14} />{t.projectDetail.deleteEpisode}
                          </button>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Expanded content — resource previews */}
                  {isExpanded && (
                    <div className="px-3 md:px-4 pb-3 md:pb-4 space-y-3 border-t border-t-border-lt pt-3 mx-3 md:mx-4">
                      {/* Script sections preview */}
                      {hasScript && (
                        <div>
                          <h4 className="text-[11px] md:text-xs font-medium text-t-text3 uppercase tracking-wider mb-2 flex items-center gap-1.5">
                            <FileText size={12} />
                            {language === 'zh' ? '脚本段落' : language === 'es' ? 'Secciones del guión' : 'Script Sections'}
                          </h4>
                          <div className="space-y-1.5">
                            {episode.scriptSections!.map((section, si) => (
                              <button
                                key={section.id}
                                onClick={() => onEditEpisode(episode)}
                                className="w-full text-left px-3 py-2.5 rounded-lg border border-t-border-lt hover:border-t-border hover:bg-t-card transition-all group/section"
                                style={{ background: `${theme.primary}04` }}
                              >
                                <div className="flex items-center justify-between">
                                  <span className="text-xs md:text-sm text-t-text2 font-medium">{section.name || `Section ${si + 1}`}</span>
                                  <span className="text-[10px] md:text-xs text-t-text3 group-hover/section:text-t-text3 transition-colors">
                                    {section.timeline.length} {language === 'zh' ? '段' : 'seg'} · {section.timeline.reduce((a, tl) => a + tl.lines.length, 0)} {language === 'zh' ? '行' : 'lines'}
                                  </span>
                                </div>
                                {section.description && (
                                  <p className="text-[11px] text-t-text3 mt-0.5 truncate">{section.description}</p>
                                )}
                                {/* Preview first line of first timeline item */}
                                {section.timeline.length > 0 && section.timeline[0].lines.length > 0 && (
                                  <p className="text-[11px] text-t-text3 mt-1 truncate italic">
                                    {section.timeline[0].lines[0].speaker}: {section.timeline[0].lines[0].line}
                                  </p>
                                )}
                              </button>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* Characters preview */}
                      {hasCharacters && (
                        <div>
                          <h4 className="text-[11px] md:text-xs font-medium text-t-text3 uppercase tracking-wider mb-2 flex items-center gap-1.5">
                            <Users size={12} />
                            {language === 'zh' ? '角色' : language === 'es' ? 'Personajes' : 'Characters'}
                          </h4>
                          <div className="flex flex-wrap gap-1.5">
                            {episode.characters!.map((char, ci) => (
                              <button
                                key={ci}
                                onClick={() => onEditEpisode(episode)}
                                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-t-border-lt hover:border-t-border hover:bg-t-card transition-all text-xs"
                                style={{ background: `${theme.primary}06` }}
                              >
                                <div className="w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-medium" style={{ background: `${theme.primary}25`, color: theme.primaryLight }}>
                                  {char.name.charAt(0).toUpperCase()}
                                </div>
                                <span className="text-t-text2">{char.name}</span>
                                {char.assignedVoiceId && (
                                  <Headphones size={10} className="text-t-text3" />
                                )}
                              </button>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* Audio player */}
                      {hasAudio && (
                        <div>
                          <h4 className="text-[11px] md:text-xs font-medium text-t-text3 uppercase tracking-wider mb-2 flex items-center gap-1.5">
                            <Headphones size={12} />
                            {language === 'zh' ? '音频' : language === 'es' ? 'Audio' : 'Audio'}
                            {episode.audioDurationMs && (
                              <span className="text-t-text3 font-normal normal-case ml-1">{formatDuration(episode.audioDurationMs)}</span>
                            )}
                          </h4>
                          <div className="rounded-lg p-3 border border-t-border-lt" style={{ background: `${theme.primary}06` }}>
                            <audio
                              ref={audioRef}
                              controls
                              className="w-full"
                              src={api.audioDataToUrl(episode.audioData!, episode.audioMimeType!)}
                              style={{ height: '32px' }}
                            />
                            <button
                              onClick={() => handleDownloadAudio(episode)}
                              className="w-full flex items-center justify-center gap-2 py-1.5 mt-2 rounded-lg text-xs text-t-text3 border border-t-border-lt hover:bg-t-card hover:text-t-text2 transition-colors"
                            >
                              <Download size={12} />
                              {language === 'zh' ? '下载音频' : language === 'es' ? 'Descargar audio' : 'Download Audio'}
                            </button>
                          </div>
                        </div>
                      )}

                      {/* Empty state for resources */}
                      {!hasScript && !hasCharacters && !hasAudio && (
                        <div className="text-center py-4">
                          <p className="text-xs text-t-text3">
                            {language === 'zh' ? '暂无资源，点击编辑添加内容' : language === 'es' ? 'Sin recursos, edite para agregar contenido' : 'No resources yet. Edit to add content.'}
                          </p>
                        </div>
                      )}

                      {/* Quick edit button */}
                      <button
                        onClick={() => onEditEpisode(episode)}
                        className="w-full flex items-center justify-center gap-2 py-2 rounded-lg text-xs font-medium text-t-text3 border border-t-border-lt hover:bg-t-card hover:text-t-text2 transition-colors"
                      >
                        <Edit2 size={12} />
                        {t.projectDetail.editContent}
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          <div className="text-center py-10 md:py-16">
            <div className="w-12 h-12 md:w-16 md:h-16 rounded-xl md:rounded-2xl flex items-center justify-center mx-auto mb-3 md:mb-4" style={{ background: `${theme.primary}20` }}>
              <FileText size={20} className="md:hidden" color={theme.primaryLight} />
              <FileText size={24} className="hidden md:block" color={theme.primaryLight} />
            </div>
            <p className="text-t-text3 mb-3 md:mb-4 text-sm md:text-base">{t.projectDetail.noEpisodes}</p>
            <button onClick={onCreateEpisode} className="inline-flex items-center gap-2 px-3 md:px-4 py-2 rounded-lg md:rounded-xl text-xs md:text-sm font-medium transition-all hover:scale-105" style={{ background: theme.accent, color: theme.primaryDark }}>
              <Plus size={16} />{t.projectDetail.addFirstEpisode}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
