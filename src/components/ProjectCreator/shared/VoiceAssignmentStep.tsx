/**
 * Shared Voice Assignment step component.
 * Shows character-voice assignment UI before synthesis starts.
 * Used by both ProjectCreator (Step 5 pre-confirm) and EpisodeCreator (Step 3 pre-confirm).
 */
import { useTheme } from '../../../contexts/ThemeContext';
import { useLanguage } from '../../../i18n/LanguageContext';
import { VoiceCharacter, ScriptSection } from '../../../types';
import {
  Mic2, User, Volume2, Play, Loader2, Sparkles, Square,
} from 'lucide-react';
import * as api from '../../../services/api';
import { VoicePickerModal } from '../../VoicePickerModal';

/** Minimal character interface shared between ProjectCreator and EpisodeCreator */
export interface CharacterForVoice {
  name: string;
  description: string;
  assignedVoiceId?: string;
  tags?: string[];
  voiceDescription?: string;
}

interface VoiceAssignmentStepProps {
  characters: CharacterForVoice[];
  systemVoices: api.Voice[];
  availableVoices: VoiceCharacter[];
  playingVoiceId: string | null;
  loadingVoiceId: string | null;
  isRecommendingVoices: boolean;
  isAnalyzingCharacters: boolean;
  generatingVoicesProgress: { current: number; total: number } | null;
  scriptSections: ScriptSection[];
  voicePickerCharIndex: number | null;
  onVoicePickerOpen: (index: number | null) => void;
  onAssignVoice: (characterIndex: number, voiceId: string) => void;
  onPlayVoice: (voiceId: string) => void;
  onGenerateAllVoices: () => void;
  onCreateVoice: (name: string, description: string, file: File) => Promise<void>;
  onVoicesUpdated: (voices: VoiceCharacter[]) => void;
}

export function VoiceAssignmentStep({
  characters,
  systemVoices,
  availableVoices,
  playingVoiceId,
  loadingVoiceId,
  isRecommendingVoices,
  isAnalyzingCharacters,
  generatingVoicesProgress,
  scriptSections,
  voicePickerCharIndex,
  onVoicePickerOpen,
  onAssignVoice,
  onPlayVoice,
  onGenerateAllVoices,
  onCreateVoice,
  onVoicesUpdated: _onVoicesUpdated,
}: VoiceAssignmentStepProps) {
  const { theme } = useTheme();
  const { language } = useLanguage();

  return (
    <div className="space-y-6">
      <div className="text-center py-4">
        <div
          className="w-16 h-16 mx-auto mb-4 rounded-full flex items-center justify-center"
          style={{ background: `${theme.primary}20` }}
        >
          <Mic2 size={32} style={{ color: theme.primaryLight }} />
        </div>
        <h3 className="text-xl font-medium text-t-text1 mb-2">
          {language === 'zh' ? '角色音色配置' : 'Character Voice Configuration'}
        </h3>
        <p className="text-base text-t-text3">
          {language === 'zh'
            ? '为每个角色选择音色，确认后开始语音合成'
            : 'Assign voices to each character, then start synthesis'}
        </p>
      </div>

      {/* Character voice assignment list */}
      {characters.length > 0 && (
        <div className="rounded-xl border border-t-border overflow-hidden" style={{ background: 'var(--t-bg-card)' }}>
          <div className="px-5 py-3 border-b border-t-border flex items-center justify-between">
            <span className="text-sm text-t-text3">
              {language === 'zh' ? '角色音色分配' : 'Character Voice Assignment'}
            </span>
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={onGenerateAllVoices}
                disabled={isRecommendingVoices || characters.filter(c => c.voiceDescription && !c.assignedVoiceId).length === 0}
                className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium transition-all disabled:opacity-50 disabled:cursor-not-allowed hover:opacity-90"
                style={{ background: `${theme.primary}25`, color: theme.primaryLight }}
                title={language === 'zh' ? '用 AI 为每个角色生成专属音色' : 'Generate a unique AI voice for each character'}
              >
                {isRecommendingVoices ? (
                  <Loader2 size={16} className="animate-spin" />
                ) : (
                  <Sparkles size={16} />
                )}
                {isRecommendingVoices && generatingVoicesProgress
                  ? `${generatingVoicesProgress.current}/${generatingVoicesProgress.total}`
                  : (language === 'zh' ? 'AI 生成全部音色' : 'Generate All Voices')
                }
              </button>
              <span className="text-xs text-t-text3">
                {characters.length} {language === 'zh' ? '个角色' : 'characters'}
              </span>
            </div>
          </div>
          <div className="p-4 space-y-3">
            {characters.map((char, index) => {
              const assignedVoiceId = char.assignedVoiceId;
              const assignedSystemVoice = systemVoices.find(v => v.id === assignedVoiceId);
              const assignedCustomVoice = availableVoices.find(v => v.id === assignedVoiceId);
              const hasAssignment = assignedSystemVoice || assignedCustomVoice;

              return (
                <div key={index} className="flex items-center gap-4 p-4 rounded-lg bg-t-card border border-t-border-lt">
                  <div className="w-12 h-12 rounded-full flex items-center justify-center bg-t-card-hover">
                    <User size={20} className="text-t-text2" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-base text-t-text1 font-medium truncate">{char.name}</p>
                    {char.description && (
                      <p className="text-sm text-t-text3 truncate">{char.description}</p>
                    )}
                    {/* Character tags */}
                    {char.tags && char.tags.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-1">
                        {char.tags.map((tag, tagIdx) => (
                          <span
                            key={tagIdx}
                            className="inline-block text-[10px] sm:text-[11px] px-1.5 py-0.5 rounded-full"
                            style={{ background: `${theme.primary}15`, color: theme.primaryLight }}
                          >
                            {tag}
                          </span>
                        ))}
                      </div>
                    )}
                    {/* Loading indicator for tag analysis */}
                    {isAnalyzingCharacters && (!char.tags || char.tags.length === 0) && (
                      <div className="flex items-center gap-1 mt-1">
                        <Loader2 size={10} className="animate-spin text-t-text3" />
                        <span className="text-[10px] text-t-text3">
                          {language === 'zh' ? '分析角色特征...' : 'Analyzing character...'}
                        </span>
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => onVoicePickerOpen(index)}
                      className="px-4 py-2.5 rounded-lg border text-base font-medium transition-all hover:scale-105 flex items-center gap-2 min-w-[160px]"
                      style={{
                        background: hasAssignment ? `${theme.primary}15` : 'var(--t-bg-card)',
                        borderColor: hasAssignment ? theme.primary : 'var(--t-border)',
                        color: hasAssignment ? theme.primaryLight : 'var(--t-text-2)',
                      }}
                    >
                      <Volume2 size={16} className="flex-shrink-0" />
                      <span className="truncate">
                        {hasAssignment
                          ? (assignedSystemVoice?.name || assignedCustomVoice?.name || '')
                          : (language === 'zh' ? '选择音色...' : 'Select voice...')}
                      </span>
                    </button>
                    {assignedVoiceId && hasAssignment && (
                      <button
                        onClick={() => onPlayVoice(assignedVoiceId)}
                        disabled={loadingVoiceId === assignedVoiceId}
                        className={`p-2.5 rounded-lg transition-all ${
                          playingVoiceId === assignedVoiceId
                            ? 'text-t-text1'
                            : 'text-t-text3 hover:text-t-text1 hover:bg-t-card-hover'
                        }`}
                        style={playingVoiceId === assignedVoiceId ? { background: theme.primary } : {}}
                        title={language === 'zh' ? '试听' : 'Preview'}
                      >
                        {loadingVoiceId === assignedVoiceId ? (
                          <Loader2 size={18} className="animate-spin" />
                        ) : playingVoiceId === assignedVoiceId ? (
                          <Square size={16} />
                        ) : (
                          <Play size={18} />
                        )}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* No characters message */}
      {characters.length === 0 && (
        <div className="text-center py-10 text-t-text3">
          <User size={40} className="mx-auto mb-3 opacity-50" />
          <p>{language === 'zh' ? '未检测到角色' : 'No characters detected'}</p>
        </div>
      )}

      {/* Voice studio hint */}
      {availableVoices.length === 0 && (
        <div
          className="p-4 rounded-xl border border-t-border flex items-start gap-3"
          style={{ background: `${theme.primary}10` }}
        >
          <Sparkles size={20} className="flex-shrink-0 mt-0.5" style={{ color: theme.primaryLight }} />
          <div>
            <p className="text-sm text-t-text2">
              {language === 'zh'
                ? '您可以在"音色工作室"中创建自定义音色，或使用系统默认音色。'
                : 'You can create custom voices in Voice Studio, or use system default voices.'}
            </p>
          </div>
        </div>
      )}

      {/* Voice Picker Modal */}
      {voicePickerCharIndex !== null && characters[voicePickerCharIndex] && (
        <VoicePickerModal
          character={characters[voicePickerCharIndex]}
          systemVoices={systemVoices}
          customVoices={availableVoices}
          playingVoiceId={playingVoiceId}
          loadingVoiceId={loadingVoiceId}
          projectVoiceIds={characters.map(c => c.assignedVoiceId).filter((id): id is string => !!id)}
          scriptSections={scriptSections}
          onAssign={(voiceId) => {
            onAssignVoice(voicePickerCharIndex, voiceId);
          }}
          onPlayVoice={onPlayVoice}
          onCreateVoice={onCreateVoice}
          onClose={() => onVoicePickerOpen(null)}
        />
      )}
    </div>
  );
}
