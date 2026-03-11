import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { useTheme } from '../contexts/ThemeContext';
import { useProjects } from '../contexts/ProjectContext';
import { useLanguage } from '../i18n/LanguageContext';
import { Project, VoiceCharacter, ScriptSection, EpisodeCharacter, isValidSpeaker } from '../types';
import { 
  ChevronLeft, ChevronRight, Check, X, Loader2,
  Music, Volume2, Image, Save,
  Mic2, Wand2,
} from 'lucide-react';
import { ReligionIconMap } from './icons/ReligionIcons';
import { collectAnalysisContent, filterValidFiles } from '../utils/fileUtils';
import { buildScriptGenerationPrompt, parseScriptGenerationResponse, validateScriptLines } from '../services/llm/prompts';
import type { BgmRecommendation } from '../services/llm/prompts';
import { analyzeScriptCharacters } from '../services/llm';
import * as api from '../services/api';
import { loadVoiceCharacters, loadVoiceCharactersFromCloud, addVoiceCharacter, saveVoiceCharacters } from '../utils/voiceStorage';
import { processAudioFile } from '../utils/audioTrim';
import type { SectionVoiceAudio, SectionVoiceStatus, ProductionProgress, MixedAudioOutput } from './ProjectCreator/reducer';
import { loadMediaItems, getMediaByType, getMediaByProject } from '../utils/mediaStorage';
import type { MediaItem } from '../types';
import { MediaPickerModal, findBestMatch, PRESET_BGM_LIST } from './MediaPickerModal';
import type { MediaPickerResult } from './MediaPickerModal';

// Shared components and hooks
import {
  ContentInputStep,
  ScriptEditorStep,
  VoiceAssignmentStep,
  VoiceGenerationProgress,
  MixingStep,
  MediaPreviewSection,
  useScriptEditorWithState,
  useVoiceGeneration,
  useMediaProduction,
  useMixingPipeline,
} from './ProjectCreator/shared';
import type { CharacterForVoice } from './ProjectCreator/shared';

interface EpisodeCreatorProps {
  project: Project;
  onClose: () => void;
  onSuccess: () => void;
}

const initialProductionProgress: ProductionProgress = {
  voiceGeneration: { status: 'idle', progress: 0, sectionStatus: {} },
  mediaProduction: { status: 'idle', progress: 0 },
  mixingEditing: { status: 'idle', progress: 0 },
};

const MAX_SCRIPT_LINES = 100;

export function EpisodeCreator({ project, onClose, onSuccess }: EpisodeCreatorProps) {
  const { theme, religion } = useTheme();
  const { addEpisode } = useProjects();
  const { t, language } = useLanguage();
  const [currentStep, setCurrentStep] = useState(1);
  
  const ReligionIcon = ReligionIconMap[religion];
  const spec = project.spec;
  
  // Episode data
  const defaultTitle = `${t.projectCreator.episode1?.replace('1', '') || 'Episode '}${project.episodes.length + 1}: ${project.title}`;
  const [title] = useState(defaultTitle);
  const [description] = useState(spec?.toneAndExpression || '');
  const [scriptSections, setScriptSections] = useState<ScriptSection[]>([]);
  const [characters, setCharacters] = useState<CharacterForVoice[]>([]);
  
  // UI state
  const [editingSection, setEditingSection] = useState<string | null>(null);
  const [isProcessingNext, setIsProcessingNext] = useState(false);
  
  // Content input state
  const [uploadedFiles, setUploadedFiles] = useState<File[]>([]);
  const [textContent, setTextContent] = useState('');
  const [isDragging, setIsDragging] = useState(false);
  const [isGeneratingScript, setIsGeneratingScript] = useState(false);
  const [streamingText, setStreamingText] = useState('');
  
  // Voice state
  const [availableVoices, setAvailableVoices] = useState<VoiceCharacter[]>([]);
  const [systemVoices, setSystemVoices] = useState<api.Voice[]>([]);
  const [voicesConfirmed, setVoicesConfirmed] = useState(false);
  const [playingVoiceId, setPlayingVoiceId] = useState<string | null>(null);
  const [loadingVoiceId, setLoadingVoiceId] = useState<string | null>(null);
  const [isRecommendingVoices, setIsRecommendingVoices] = useState(false);
  const [isAnalyzingCharacters, setIsAnalyzingCharacters] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [voicePickerCharIndex, setVoicePickerCharIndex] = useState<number | null>(null);
  const [generatingVoicesProgress, setGeneratingVoicesProgress] = useState<{ current: number; total: number } | null>(null);
  
  // Media state
  const [mediaSelectionsConfirmed, setMediaSelectionsConfirmed] = useState(false);
  const [bgmSelection, setBgmSelection] = useState<MediaPickerResult | null>(null);
  const [sfxSelections, setSfxSelections] = useState<Record<string, MediaPickerResult>>({});
  const [mediaPickerOpen, setMediaPickerOpen] = useState<string | null>(null);
  const [cachedMediaItems, setCachedMediaItems] = useState<MediaItem[]>([]);
  const [bgmRecommendation, setBgmRecommendation] = useState<BgmRecommendation | null>(null);
  const [regeneratingId, setRegeneratingId] = useState<string | null>(null);
  
  // Per-line voice regeneration state
  const [regeneratingLineId, setRegeneratingLineId] = useState<string | null>(null);
  const [listenedSegments, setListenedSegments] = useState<Set<string>>(new Set());

  // Production state
  const [production, setProduction] = useState<ProductionProgress>(initialProductionProgress);

  // Use shared script editor hook
  const scriptActions = useScriptEditorWithState(setScriptSections, MAX_SCRIPT_LINES);

  // Computed values
  const totalLineCount = useMemo(() => {
    return scriptSections.reduce((total, section) => {
      return total + section.timeline.reduce((sectionTotal, item) => {
        return sectionTotal + (item.lines?.length || 0);
      }, 0);
    }, 0);
  }, [scriptSections]);

  const knownSpeakers = useMemo(() => {
    const names = new Set<string>();
    characters.forEach(c => { if (c.name) names.add(c.name); });
    scriptSections.forEach(section => {
      section.timeline.forEach(item => {
        (item.lines || []).forEach(line => {
          if (line.speaker?.trim()) names.add(line.speaker.trim());
        });
      });
    });
    return Array.from(names);
  }, [characters, scriptSections]);

  // 6-step workflow
  const STEPS = [
    { id: 1, title: language === 'zh' ? '内容输入' : 'Content Input', description: language === 'zh' ? '上传或输入您的内容' : 'Upload or enter your content' },
    { id: 2, title: language === 'zh' ? '脚本生成' : 'Script Generation', description: language === 'zh' ? '生成时间轴脚本' : 'Generate timeline scripts' },
    { id: 3, title: language === 'zh' ? '语音生成' : 'Voice Generation', description: language === 'zh' ? '逐段生成语音' : 'Chunk-by-chunk voice generation' },
    { id: 4, title: language === 'zh' ? '媒体制作' : 'Media Production', description: language === 'zh' ? '音乐、音效和图片' : 'Music, sound effects, and images' },
    { id: 5, title: language === 'zh' ? '混音编辑' : 'Mixing & Editing', description: language === 'zh' ? '混音和时间轴编辑' : 'Mixing and timeline editing' },
    { id: 6, title: language === 'zh' ? '保存' : 'Save', description: language === 'zh' ? '确认并保存' : 'Confirm and save' },
  ];

  // ============================================================
  // Production state helpers
  // ============================================================
  const updateProductionPhase = useCallback((
    phase: 'voice-generation' | 'media-production' | 'mixing-editing',
    status: 'idle' | 'processing' | 'completed' | 'error',
    progress: number,
    detail?: string
  ) => {
    setProduction(prev => {
      const next = { ...prev };
      if (phase === 'voice-generation') {
        next.voiceGeneration = { ...prev.voiceGeneration, status, progress, currentChunk: detail };
      } else if (phase === 'media-production') {
        next.mediaProduction = { ...prev.mediaProduction, status, progress, currentTask: detail };
      } else if (phase === 'mixing-editing') {
        next.mixingEditing = { ...prev.mixingEditing, status, progress };
      }
      return next;
    });
  }, []);

  const updateSectionVoiceStatus = useCallback((sectionId: string, status: SectionVoiceStatus['status'], progress?: number, error?: string) => {
    setProduction(prev => {
      const sectionStatus = { ...prev.voiceGeneration.sectionStatus };
      if (!sectionStatus[sectionId]) sectionStatus[sectionId] = { status: 'idle', progress: 0, audioSegments: [] };
      sectionStatus[sectionId] = { ...sectionStatus[sectionId], status, ...(progress !== undefined && { progress }), ...(error !== undefined && { error }) };
      return { ...prev, voiceGeneration: { ...prev.voiceGeneration, sectionStatus } };
    });
  }, []);

  const addSectionVoiceAudio = useCallback((sectionId: string, audio: SectionVoiceAudio) => {
    setProduction(prev => {
      const sectionStatus = { ...prev.voiceGeneration.sectionStatus };
      if (!sectionStatus[sectionId]) sectionStatus[sectionId] = { status: 'processing', progress: 0, audioSegments: [] };
      sectionStatus[sectionId] = { ...sectionStatus[sectionId], audioSegments: [...sectionStatus[sectionId].audioSegments, audio] };
      return { ...prev, voiceGeneration: { ...prev.voiceGeneration, sectionStatus } };
    });
  }, []);

  const replaceSectionVoiceAudio = useCallback((sectionId: string, audioIndex: number, audio: SectionVoiceAudio) => {
    setProduction(prev => {
      const sectionStatus = { ...prev.voiceGeneration.sectionStatus };
      if (!sectionStatus[sectionId]) return prev;
      const segments = [...sectionStatus[sectionId].audioSegments];
      if (audioIndex >= 0 && audioIndex < segments.length) {
        segments[audioIndex] = audio;
        sectionStatus[sectionId] = { ...sectionStatus[sectionId], audioSegments: segments };
      }
      return { ...prev, voiceGeneration: { ...prev.voiceGeneration, sectionStatus } };
    });
  }, []);

  const clearSectionVoice = useCallback((sectionId: string) => {
    setProduction(prev => {
      const sectionStatus = { ...prev.voiceGeneration.sectionStatus };
      sectionStatus[sectionId] = { status: 'idle', progress: 0, audioSegments: [] };
      return { ...prev, voiceGeneration: { ...prev.voiceGeneration, sectionStatus } };
    });
  }, []);

  const setCurrentSection = useCallback((sectionId: string | undefined) => {
    setProduction(prev => ({ ...prev, voiceGeneration: { ...prev.voiceGeneration, currentSectionId: sectionId } }));
  }, []);

  const setBgmAudio = useCallback((audio: { audioData?: string; audioUrl?: string; mimeType: string }) => {
    setProduction(prev => ({ ...prev, mediaProduction: { ...prev.mediaProduction, bgmAudio: audio } }));
  }, []);

  const addSfxAudio = useCallback((sfx: { name: string; prompt: string; audioData: string; mimeType: string }) => {
    setProduction(prev => ({ ...prev, mediaProduction: { ...prev.mediaProduction, sfxAudios: [...(prev.mediaProduction.sfxAudios || []), sfx] } }));
  }, []);

  const updateSfxAudio = useCallback((index: number, sfx: { name: string; prompt: string; audioData: string; mimeType: string }) => {
    setProduction(prev => {
      const sfxAudios = [...(prev.mediaProduction.sfxAudios || [])];
      if (sfxAudios[index]) sfxAudios[index] = sfx;
      return { ...prev, mediaProduction: { ...prev.mediaProduction, sfxAudios } };
    });
  }, []);

  const setMixedOutput = useCallback((output: MixedAudioOutput) => {
    setProduction(prev => ({ ...prev, mixingEditing: { ...prev.mixingEditing, output, error: undefined } }));
  }, []);

  const setMixingError = useCallback((error: string) => {
    setProduction(prev => ({ ...prev, mixingEditing: { ...prev.mixingEditing, error } }));
  }, []);

  // ============================================================
  // Load voices on mount
  // ============================================================
  useEffect(() => {
    // Start with in-memory cache, then refresh from cloud
    setAvailableVoices(loadVoiceCharacters());
    loadVoiceCharactersFromCloud()
      .then(voices => { if (voices.length > 0) setAvailableVoices(voices); })
      .catch(err => console.error('Failed to load voices from cloud:', err));
    api.getVoices()
      .then(voices => setSystemVoices(voices))
      .catch(err => console.error('Failed to load system voices:', err));
  }, []);

  useEffect(() => {
    if (currentStep !== 3 && audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
      setPlayingVoiceId(null);
    }
  }, [currentStep]);

  // ============================================================
  // File upload handlers (for ContentInputStep)
  // ============================================================
  const handleFilesAdded = useCallback((files: File[]) => {
    const validFiles = filterValidFiles(files as unknown as FileList);
    if (validFiles.length > 0) {
      setUploadedFiles(prev => [...prev, ...validFiles]);
    } else {
      alert(t.projectCreator?.errors?.uploadFileType || 'Invalid file type');
    }
  }, [t]);

  const handleFileRemoved = useCallback((index: number) => {
    setUploadedFiles(prev => prev.filter((_, i) => i !== index));
  }, []);

  // ============================================================
  // Script generation (streaming)
  // ============================================================
  const MAX_SCRIPT_RETRIES = 2;
  const generateScript = async () => {
    setIsGeneratingScript(true);
    setStreamingText('');
    try {
      const hasFiles = uploadedFiles.length > 0;
      const hasText = textContent.trim().length > 0;

      const userInstructions = (hasFiles && hasText) ? textContent : undefined;
      const textForCollection = (hasFiles && hasText) ? '' : textContent;

      const { text: content, attachments } = await collectAnalysisContent(
        textForCollection, uploadedFiles, { includeLabels: false, returnAttachments: true }
      );
      if (!content.trim() && attachments.length === 0) {
        alert(t.projectCreator?.errors?.inputOrUpload || 'Please input or upload content');
        setIsGeneratingScript(false);
        return;
      }

      const promptConfig = {
        title: title || 'Episode',
        targetAudience: spec?.targetAudience || '',
        formatAndDuration: spec?.formatAndDuration || '',
        toneAndExpression: spec?.toneAndExpression || '',
        addBgm: spec?.addBgm || false,
        addSoundEffects: spec?.addSoundEffects || false,
        hasVisualContent: spec?.hasVisualContent || false,
      };

      let lastSections: unknown[] = [];
      let lastBgmRec: BgmRecommendation | undefined;

      for (let attempt = 0; attempt <= MAX_SCRIPT_RETRIES; attempt++) {
        if (attempt > 0) {
          console.warn(`Script generation attempt ${attempt + 1}: retrying due to empty lines`);
          setStreamingText('');
        }

        const prompt = buildScriptGenerationPrompt(content, promptConfig, userInstructions);
        const finalText = await api.generateTextStream(prompt, (chunk) => { setStreamingText(chunk.accumulated); }, { attachments });
        const { sections, bgmRecommendation: bgmRec } = parseScriptGenerationResponse(finalText);
        lastSections = sections;
        lastBgmRec = bgmRec;

        if (validateScriptLines(sections)) break;
      }

      const typedSections = lastSections as ScriptSection[];
      if (typedSections && typedSections.length > 0) {
        setScriptSections(typedSections);
        setEditingSection(typedSections[0].id);
      }
      if (lastBgmRec) setBgmRecommendation(lastBgmRec);
    } catch (error) {
      console.error('Script generation error:', error);
      alert(t.projectCreator?.errors?.unknownError || 'An error occurred');
    } finally {
      setIsGeneratingScript(false);
      setStreamingText('');
    }
  };

  // ============================================================
  // Character extraction & voice assignment
  // ============================================================
  const extractCharacters = useCallback(() => {
    const speakerSet = new Set<string>();
    scriptSections.forEach(section => {
      section.timeline.forEach(item => {
        (item.lines || []).forEach(line => {
          if (isValidSpeaker(line.speaker)) speakerSet.add(line.speaker.trim());
        });
      });
    });
    const extractedChars: CharacterForVoice[] = Array.from(speakerSet).map(name => ({ name, description: '' }));
    setCharacters(extractedChars);
    setAvailableVoices(loadVoiceCharacters());

    const charNames = Array.from(speakerSet);
    if (charNames.length > 0) {
      setIsAnalyzingCharacters(true);
      analyzeScriptCharacters(JSON.stringify(scriptSections), charNames, language === 'zh' ? 'zh' : 'en')
        .then(analysisResult => {
          setCharacters(prev => prev.map(char => {
            const analysis = analysisResult[char.name];
            if (!analysis) return char;
            return { ...char, tags: analysis.tags?.length ? analysis.tags : char.tags, voiceDescription: analysis.voiceDescription || char.voiceDescription };
          }));
        })
        .catch(err => console.error('Character analysis failed:', err))
        .finally(() => setIsAnalyzingCharacters(false));
    }
  }, [scriptSections, language]);

  const assignVoiceToCharacter = useCallback((characterIndex: number, voiceId: string) => {
    setCharacters(chars => chars.map((char, idx) => idx === characterIndex ? { ...char, assignedVoiceId: voiceId } : char));
  }, []);

  // AI generate voices for all characters
  const generateVoicesForAll = useCallback(async () => {
    const charsToGenerate = characters.map((c, idx) => ({ ...c, idx })).filter(c => c.voiceDescription && !c.assignedVoiceId);
    if (charsToGenerate.length === 0) return;
    setIsRecommendingVoices(true);
    setGeneratingVoicesProgress({ current: 0, total: charsToGenerate.length });
    for (let i = 0; i < charsToGenerate.length; i++) {
      const char = charsToGenerate[i];
      setGeneratingVoicesProgress({ current: i + 1, total: charsToGenerate.length });
      try {
        const result = await api.designVoice(char.voiceDescription!);
        if (result.previews.length === 0) continue;
        const preview = result.previews[0];
        const dataUrl = `data:${preview.mediaType || 'audio/mpeg'};base64,${preview.audioBase64}`;
        const updatedVoices = addVoiceCharacter(availableVoices, { name: char.name, description: char.voiceDescription || '', refAudioDataUrl: dataUrl, audioSampleUrl: dataUrl, tags: ['ai-generated'] });
        const newVoice = updatedVoices[updatedVoices.length - 1];
        setAvailableVoices(updatedVoices);
        assignVoiceToCharacter(char.idx, newVoice.id);
      } catch (err) {
        console.error(`Failed to generate voice for ${char.name}:`, err);
      }
    }
    setIsRecommendingVoices(false);
    setGeneratingVoicesProgress(null);
  }, [characters, availableVoices, assignVoiceToCharacter]);

  // Play voice sample preview
  const playVoiceSample = async (voiceId: string) => {
    if (playingVoiceId === voiceId) { audioRef.current?.pause(); audioRef.current = null; setPlayingVoiceId(null); return; }
    if (audioRef.current) { audioRef.current.pause(); audioRef.current = null; }
    try {
      setLoadingVoiceId(voiceId); setPlayingVoiceId(null);
      const customVoice = availableVoices.find(v => v.id === voiceId);
      const customAudioUrl = customVoice?.refAudioDataUrl || customVoice?.audioSampleUrl;
      let audio: HTMLAudioElement;
      if (customAudioUrl) { audio = new Audio(customAudioUrl); await audio.play(); }
      else { audio = await api.playVoiceSample(voiceId, language === 'zh' ? 'zh' : 'en'); }
      audioRef.current = audio; setPlayingVoiceId(voiceId); setLoadingVoiceId(null);
      audio.onended = () => { setPlayingVoiceId(null); audioRef.current = null; };
      audio.onerror = () => { setPlayingVoiceId(null); setLoadingVoiceId(null); audioRef.current = null; };
    } catch (error) { console.error('Failed to play voice sample:', error); setLoadingVoiceId(null); setPlayingVoiceId(null); }
  };

  const handleCreateVoice = async (name: string, description: string, file: File) => {
    const charIndex = voicePickerCharIndex;
    try {
      const { dataUrl } = await processAudioFile(file);
      const updatedVoices = loadVoiceCharacters();
      const newVoice: VoiceCharacter = {
        id: crypto.randomUUID(), name, description: description || (language === 'zh' ? '自定义音色' : 'Custom voice'),
        refAudioDataUrl: dataUrl, audioSampleUrl: dataUrl, tags: ['uploaded'],
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      };
      const allVoices = [...updatedVoices, newVoice];
      saveVoiceCharacters(allVoices);
      setAvailableVoices(allVoices);
      if (charIndex !== null) assignVoiceToCharacter(charIndex, newVoice.id);
    } catch (error) {
      console.error('Failed to create voice:', error);
      alert(language === 'zh' ? '创建音色失败' : 'Failed to create voice');
      throw error;
    }
  };

  // ============================================================
  // Shared orchestration hooks (voice, media, mixing)
  // ============================================================
  const scriptSectionsRef = useRef(scriptSections);
  scriptSectionsRef.current = scriptSections;
  const charactersRef = useRef(characters);
  charactersRef.current = characters;
  const availableVoicesRef = useRef(availableVoices);
  availableVoicesRef.current = availableVoices;
  const systemVoicesRef = useRef(systemVoices);
  systemVoicesRef.current = systemVoices;
  const productionRef = useRef(production);
  productionRef.current = production;
  const bgmSelectionRef = useRef(bgmSelection);
  bgmSelectionRef.current = bgmSelection;
  const sfxSelectionsRef = useRef(sfxSelections);
  sfxSelectionsRef.current = sfxSelections;

  const { generateVoiceForSection, performVoiceGeneration, regenerateVoiceForLine } = useVoiceGeneration({
    getScriptSections: () => scriptSectionsRef.current,
    getCharacters: () => charactersRef.current,
    getAvailableVoices: () => availableVoicesRef.current,
    getSystemVoices: () => systemVoicesRef.current,
    language,
    updateSectionVoiceStatus,
    setCurrentSection,
    addSectionVoiceAudio,
    replaceSectionVoiceAudio,
    updateProductionPhase,
    setRegeneratingLineId,
    setListenedSegments,
  });

  const { performMediaProduction, handleRegenMedia } = useMediaProduction({
    getScriptSections: () => scriptSectionsRef.current,
    getSpec: () => spec || { addBgm: false, addSoundEffects: false, hasVisualContent: false, toneAndExpression: '' },
    getBgmSelection: () => bgmSelectionRef.current,
    getSfxSelections: () => sfxSelectionsRef.current,
    getProduction: () => productionRef.current,
    language,
    projectId: project.id,
    title,
    setBgmAudio,
    addSfxAudio,
    updateSfxAudio,
    updateProductionPhase,
    setMediaSelectionsConfirmed,
    setRegeneratingId,
  });

  const { performMixing } = useMixingPipeline({
    getScriptSections: () => scriptSectionsRef.current,
    getProduction: () => productionRef.current,
    getSpec: () => spec || { addBgm: false },
    language,
    updateProductionPhase,
    setMixedOutput,
    setMixingError,
  });

  const startVoiceGeneration = () => { setVoicesConfirmed(true); performVoiceGeneration(); };

  const initializeMediaSelections = useCallback(() => {
    const allItems = loadMediaItems();
    setCachedMediaItems(allItems);
    const bgmItems = getMediaByType(allItems, 'bgm');
    const sfxItems = getMediaByType(allItems, 'sfx');
    const projectBgm = getMediaByProject(bgmItems, project.id);
    const projectSfx = getMediaByProject(sfxItems, project.id);
    if (spec?.addBgm) {
      const bgmPrompt = spec.toneAndExpression || '';
      const bestMatch = findBestMatch(projectBgm, bgmPrompt, 'bgm') || findBestMatch(bgmItems, bgmPrompt, 'bgm');
      if (bestMatch) {
        setBgmSelection({ source: 'library', mediaItem: bestMatch.item, prompt: bestMatch.item.prompt || bestMatch.item.description, duration: bestMatch.item.duration });
      } else {
        const aiPreset = bgmRecommendation ? PRESET_BGM_LIST.find(p => p.id === bgmRecommendation.presetId) : null;
        const preset = aiPreset || PRESET_BGM_LIST[0];
        setBgmSelection({ source: 'preset', prompt: bgmRecommendation?.description || (language === 'zh' ? preset.description.zh : preset.description.en), audioUrl: preset.url, presetId: preset.id });
      }
    }
    if (spec?.addSoundEffects) {
      const newSfxSelections: Record<string, MediaPickerResult> = {};
      for (const section of scriptSections) {
        for (const item of section.timeline) {
          if (item.soundMusic?.trim()) {
            const key = `${section.id}-${item.id}`;
            const bestMatch = findBestMatch(projectSfx, item.soundMusic, 'sfx') || findBestMatch(sfxItems, item.soundMusic, 'sfx');
            newSfxSelections[key] = bestMatch
              ? { source: 'library', mediaItem: bestMatch.item, prompt: bestMatch.item.prompt || bestMatch.item.description, duration: bestMatch.item.duration }
              : { source: 'generate', prompt: item.soundMusic, duration: 5 };
          }
        }
      }
      setSfxSelections(newSfxSelections);
    }
  }, [spec, scriptSections, project.id, language, bgmRecommendation]);

  // ============================================================
  // Save episode
  // ============================================================
  const handleSave = () => {
    if (!title.trim()) { alert(t.episodeEditor.validation.titleRequired); return; }
    const episodeCharacters: EpisodeCharacter[] = characters.map(char => ({ name: char.name, description: char.description, assignedVoiceId: char.assignedVoiceId, tags: char.tags }));
    const mixedOutput = production.mixingEditing.output;
    let stage: 'planning' | 'scripting' | 'recording' | 'editing' | 'review' | 'published' = 'scripting';
    if (mixedOutput?.audioData) stage = 'review';
    else if (production.voiceGeneration.status === 'completed') stage = 'editing';
    else if (scriptSections.length > 0) stage = 'scripting';
    addEpisode(project.id, { title: title || `Episode ${project.episodes.length + 1}`, description, script: '', scriptSections, characters: episodeCharacters, audioData: mixedOutput?.audioData, audioMimeType: mixedOutput?.mimeType, audioDurationMs: mixedOutput?.durationMs, stage, notes: '' });
    onSuccess();
  };

  // ============================================================
  // Navigation
  // ============================================================
  const canProceed = () => {
    switch (currentStep) {
      case 1: return textContent.trim().length > 0 || uploadedFiles.length > 0;
      case 2: return scriptSections.length > 0;
      case 3: return voicesConfirmed && production.voiceGeneration.status === 'completed';
      case 4: return production.mediaProduction.status === 'completed';
      case 5: return production.mixingEditing.status === 'completed';
      default: return true;
    }
  };

  const handleNext = async () => {
    if (currentStep === 1) { setCurrentStep(2); setTimeout(() => generateScript(), 100); return; }
    if (currentStep === 2 && scriptSections.length > 0) {
      setIsProcessingNext(true); extractCharacters(); await new Promise(resolve => setTimeout(resolve, 300));
      setIsProcessingNext(false); setCurrentStep(3); setVoicesConfirmed(false); return;
    }
    if (currentStep === 3 && production.voiceGeneration.status === 'completed') {
      setCurrentStep(4); setMediaSelectionsConfirmed(false); setTimeout(() => initializeMediaSelections(), 100); return;
    }
    if (currentStep === 4 && production.mediaProduction.status === 'completed') { setCurrentStep(5); setTimeout(() => performMixing(), 100); return; }
    if (currentStep === 5 && production.mixingEditing.status === 'completed') { setCurrentStep(6); return; }
    if (currentStep < STEPS.length) setCurrentStep(currentStep + 1);
  };

  const handleBack = () => { if (currentStep > 1) setCurrentStep(currentStep - 1); };

  // ============================================================
  // Render: Media Production Step (still inline due to picker modal complexity)
  // ============================================================
  const renderMediaProductionStep = () => {
    const { mediaProduction } = production;
    const hasBgm = spec?.addBgm;
    const hasSfx = spec?.addSoundEffects;
    const hasImages = spec?.hasVisualContent;
    const sfxNeeds: { sectionId: string; sectionName: string; itemId: string; prompt: string }[] = [];
    if (hasSfx) {
      for (const section of scriptSections) {
        for (const item of section.timeline) {
          if (item.soundMusic?.trim()) sfxNeeds.push({ sectionId: section.id, sectionName: section.name, itemId: item.id, prompt: item.soundMusic });
        }
      }
    }
    const bgmLibraryItems = getMediaByType(cachedMediaItems, 'bgm');
    const sfxLibraryItems = getMediaByType(cachedMediaItems, 'sfx');
    const projectItemIds = cachedMediaItems.filter(i => i.projectIds?.includes(project.id)).map(i => i.id);
    const libraryCount = (bgmSelection?.source === 'library' ? 1 : 0) + Object.values(sfxSelections).filter(s => s.source === 'library').length;
    const generateCount = (bgmSelection?.source === 'generate' ? 1 : 0) + Object.values(sfxSelections).filter(s => s.source === 'generate').length;

    if (!mediaSelectionsConfirmed) {
      return (
        <div className="space-y-6">
          <div className="text-center py-4">
            <div className="w-16 h-16 mx-auto mb-4 rounded-full flex items-center justify-center" style={{ background: `${theme.primary}20` }}>
              <Music size={32} style={{ color: theme.primaryLight }} />
            </div>
            <h3 className="text-xl font-medium text-t-text1 mb-2">{language === 'zh' ? '选择媒体素材' : 'Select Media Assets'}</h3>
            <p className="text-base text-t-text3">{language === 'zh' ? '从媒体库选择已有素材，或生成新的' : 'Choose from your library or generate new ones'}</p>
            {(libraryCount > 0 || generateCount > 0) && (
              <p className="text-xs text-t-text3 mt-2">
                {language === 'zh'
                  ? `${libraryCount > 0 ? `${libraryCount} 个来自媒体库` : ''}${libraryCount > 0 && generateCount > 0 ? '，' : ''}${generateCount > 0 ? `${generateCount} 个需要生成` : ''}`
                  : `${libraryCount > 0 ? `${libraryCount} from library` : ''}${libraryCount > 0 && generateCount > 0 ? ', ' : ''}${generateCount > 0 ? `${generateCount} to generate` : ''}`}
              </p>
            )}
          </div>
          {hasBgm && (
            <div className="space-y-2">
              <div className="flex items-center gap-2"><Music size={16} style={{ color: theme.primaryLight }} /><span className="text-sm font-medium text-t-text2">{language === 'zh' ? '背景音乐' : 'Background Music'}</span></div>
              <div className="flex items-center gap-3 p-4 rounded-xl border border-t-border cursor-pointer transition-all hover:border-t-border group" style={{ background: 'var(--t-bg-card)' }} onClick={() => setMediaPickerOpen('bgm')}>
                <div className="w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0" style={{ background: `${theme.primary}20` }}><Music size={18} style={{ color: theme.primaryLight }} /></div>
                <div className="flex-1 min-w-0">
                  {bgmSelection?.source === 'preset' && bgmSelection.presetId ? (
                    <><p className="text-sm font-medium text-t-text1 truncate">{(() => { const preset = PRESET_BGM_LIST.find(p => p.id === bgmSelection.presetId); return preset ? (language === 'zh' ? preset.name.zh : preset.name.en) : bgmSelection.presetId; })()}<span className="ml-2 inline-block text-[10px] px-1.5 py-0.5 rounded" style={{ background: `${theme.primary}15`, color: theme.primaryLight }}>{language === 'zh' ? '默认' : 'Preset'}</span></p><p className="text-xs text-t-text3 truncate">{bgmSelection.prompt}</p></>
                  ) : bgmSelection?.source === 'library' && bgmSelection.mediaItem ? (
                    <><p className="text-sm font-medium text-t-text1 truncate">{bgmSelection.mediaItem.name}<span className="ml-2 inline-block text-[10px] px-1.5 py-0.5 rounded" style={{ background: `${theme.primary}15`, color: theme.primaryLight }}>{language === 'zh' ? '媒体库' : 'Library'}</span></p><p className="text-xs text-t-text3 truncate">{bgmSelection.mediaItem.prompt || bgmSelection.mediaItem.description}</p></>
                  ) : bgmSelection?.source === 'generate' ? (
                    <><p className="text-sm font-medium text-t-text1 truncate">{language === 'zh' ? '生成新的 BGM' : 'Generate New BGM'}<span className="ml-2 inline-block text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-500">{language === 'zh' ? '将生成' : 'Will generate'}</span></p><p className="text-xs text-t-text3 truncate">{bgmSelection.prompt}</p></>
                  ) : (<p className="text-sm text-t-text3">{language === 'zh' ? '点击选择...' : 'Click to choose...'}</p>)}
                </div>
                <ChevronRight size={16} className="text-t-text3 group-hover:text-t-text2 transition-colors flex-shrink-0" />
              </div>
            </div>
          )}
          {hasSfx && sfxNeeds.length > 0 && (
            <div className="space-y-2">
              <div className="flex items-center gap-2"><Volume2 size={16} style={{ color: theme.primaryLight }} /><span className="text-sm font-medium text-t-text2">{language === 'zh' ? '音效' : 'Sound Effects'}</span><span className="text-xs text-t-text3">({sfxNeeds.length})</span></div>
              <div className="space-y-2">
                {sfxNeeds.map((need) => {
                  const key = `${need.sectionId}-${need.itemId}`;
                  const sel = sfxSelections[key];
                  return (
                    <div key={key} className="flex items-center gap-3 p-3 rounded-xl border border-t-border cursor-pointer transition-all hover:border-t-border group" style={{ background: 'var(--t-bg-card)' }} onClick={() => setMediaPickerOpen(`sfx-${key}`)}>
                      <div className="w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0" style={{ background: `${theme.primary}20` }}><Volume2 size={14} style={{ color: theme.primaryLight }} /></div>
                      <div className="flex-1 min-w-0">
                        {sel?.source === 'library' && sel.mediaItem ? (
                          <><p className="text-sm font-medium text-t-text1 truncate">{sel.mediaItem.name}<span className="ml-2 inline-block text-[10px] px-1.5 py-0.5 rounded" style={{ background: `${theme.primary}15`, color: theme.primaryLight }}>{language === 'zh' ? '媒体库' : 'Library'}</span></p><p className="text-xs text-t-text3 truncate">{need.prompt}</p></>
                        ) : sel?.source === 'generate' ? (
                          <><p className="text-sm font-medium text-t-text1 truncate">{need.sectionName} - SFX<span className="ml-2 inline-block text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-500">{language === 'zh' ? '将生成' : 'Will generate'}</span></p><p className="text-xs text-t-text3 truncate">{need.prompt}</p></>
                        ) : (<><p className="text-sm text-t-text3 truncate">{need.prompt}</p><p className="text-[10px] text-t-text3">{need.sectionName}</p></>)}
                      </div>
                      <ChevronRight size={14} className="text-t-text3 group-hover:text-t-text2 transition-colors flex-shrink-0" />
                    </div>
                  );
                })}
              </div>
            </div>
          )}
          {!hasBgm && !hasSfx && !hasImages && (<div className="text-center py-10 text-t-text3 text-base">{language === 'zh' ? '此项目不需要额外媒体' : 'No additional media needed'}</div>)}
          {mediaPickerOpen === 'bgm' && (
            <MediaPickerModal mode="bgm" prompt={spec?.toneAndExpression || ''} libraryItems={bgmLibraryItems} preSelectedId={bgmSelection?.source === 'library' ? bgmSelection.mediaItem?.id : undefined} preSelectedPresetId={bgmSelection?.source === 'preset' ? bgmSelection.presetId : undefined} aiRecommendedPresetId={bgmRecommendation?.presetId} aiIdealDescription={bgmRecommendation?.description} projectItemIds={projectItemIds} onConfirm={(result) => { setBgmSelection(result); setMediaPickerOpen(null); }} onClose={() => setMediaPickerOpen(null)} />
          )}
          {mediaPickerOpen?.startsWith('sfx-') && (() => {
            const key = mediaPickerOpen.slice(4);
            const need = sfxNeeds.find(n => `${n.sectionId}-${n.itemId}` === key);
            if (!need) return null;
            const sel = sfxSelections[key];
            return (<MediaPickerModal mode="sfx" prompt={need.prompt} desiredDuration={5} libraryItems={sfxLibraryItems} preSelectedId={sel?.source === 'library' ? sel.mediaItem?.id : undefined} projectItemIds={projectItemIds} onConfirm={(result) => { setSfxSelections(prev => ({ ...prev, [key]: result })); setMediaPickerOpen(null); }} onClose={() => setMediaPickerOpen(null)} />);
          })()}
        </div>
      );
    }

    // Phase 2: Production progress
    return (
      <div className="space-y-6">
        <div className="text-center py-6">
          <div className="w-20 h-20 mx-auto mb-5 rounded-full flex items-center justify-center" style={{ background: `${theme.primary}20` }}>
            {mediaProduction.status === 'completed' ? (<Check size={40} style={{ color: theme.primaryLight }} />) : (<Music size={40} className={mediaProduction.status === 'processing' ? 'animate-pulse' : ''} style={{ color: theme.primaryLight }} />)}
          </div>
          <h3 className="text-xl font-medium text-t-text1 mb-2">{language === 'zh' ? '媒体制作' : 'Media Production'}</h3>
          <p className="text-base text-t-text3">{mediaProduction.status === 'completed' ? (language === 'zh' ? '媒体制作完成' : 'Media production complete') : mediaProduction.currentTask || (language === 'zh' ? '准备中...' : 'Preparing...')}</p>
        </div>
        {mediaProduction.status === 'processing' && (
          <div className="space-y-3">
            <div className="flex items-center justify-between text-sm text-t-text3"><span>{language === 'zh' ? '进度' : 'Progress'}</span><span>{mediaProduction.progress}%</span></div>
            <div className="h-3 rounded-full bg-t-card-hover overflow-hidden"><div className="h-full rounded-full transition-all duration-500" style={{ width: `${mediaProduction.progress}%`, background: theme.primary }} /></div>
          </div>
        )}
        {mediaProduction.status === 'completed' && (
          <MediaPreviewSection production={production} onRegenMedia={handleRegenMedia} regeneratingId={regeneratingId} bgmSelection={bgmSelection} toneDescription={spec?.toneAndExpression} />
        )}
      </div>
    );
  };

  // ============================================================
  // Render: Save Step
  // ============================================================
  const renderSaveStep = () => (
    <div className="space-y-6">
      <div className="text-center py-6">
        <div className="w-20 h-20 mx-auto mb-5 rounded-full flex items-center justify-center" style={{ background: `${theme.primary}30` }}><Check size={40} style={{ color: theme.primaryLight }} /></div>
        <h3 className="text-xl font-medium text-t-text1 mb-2">{language === 'zh' ? '准备就绪！' : 'Ready to Save!'}</h3>
        <p className="text-base text-t-text3">{language === 'zh' ? '确认以下信息并保存剧集' : 'Confirm the details below and save your episode'}</p>
      </div>
      <div className="rounded-xl p-6 border border-t-border" style={{ background: `${theme.primary}10` }}>
        <div className="flex items-center gap-4 mb-5">
          <div className="w-14 h-14 rounded-xl flex items-center justify-center" style={{ background: `${theme.primary}30` }}><ReligionIcon size={28} color={theme.primaryLight} /></div>
          <div className="flex-1"><h3 className="text-2xl font-serif text-t-text1">{title}</h3><p className="text-base text-t-text3">{project.title}</p></div>
        </div>
        <div className="space-y-4 text-base">
          {description && <p className="text-t-text2 line-clamp-2">{description}</p>}
          <div className="flex items-center gap-4 text-sm text-t-text2">
            <span>{scriptSections.length} {language === 'zh' ? '段落' : 'sections'}</span><span>·</span>
            <span>{characters.length} {language === 'zh' ? '角色' : 'characters'}</span>
            {spec?.addBgm && (<><span>·</span><span className="flex items-center gap-1" style={{ color: theme.primaryLight }}><Music size={14} /> BGM</span></>)}
            {spec?.addSoundEffects && (<><span>·</span><span className="flex items-center gap-1" style={{ color: theme.primaryLight }}><Volume2 size={14} /> SFX</span></>)}
            {spec?.hasVisualContent && (<><span>·</span><span className="flex items-center gap-1" style={{ color: theme.primaryLight }}><Image size={14} /> {language === 'zh' ? '视觉' : 'Visual'}</span></>)}
          </div>
        </div>
      </div>
      <p className="text-center text-t-text3 text-sm">{language === 'zh' ? '点击下方按钮保存剧集' : 'Click the button below to save your episode'}</p>
    </div>
  );

  // ============================================================
  // Main render
  // ============================================================
  const renderStepContent = () => {
    switch (currentStep) {
      case 1: return (
        <ContentInputStep
          textContent={textContent} onTextChange={setTextContent}
          uploadedFiles={uploadedFiles} onFilesAdded={handleFilesAdded} onFileRemoved={handleFileRemoved}
          isDragging={isDragging} onDragStateChange={setIsDragging}
        />
      );
      case 2: return (
        <ScriptEditorStep
          scriptSections={scriptSections} editingSection={editingSection} onEditingSectionChange={setEditingSection}
          isGeneratingScript={isGeneratingScript} streamingText={streamingText} onGenerateScript={generateScript}
          actions={scriptActions} knownSpeakers={knownSpeakers} totalLineCount={totalLineCount} maxScriptLines={MAX_SCRIPT_LINES}
          hasVisualContent={spec?.hasVisualContent} hasAudio={spec?.addBgm || spec?.addSoundEffects} t={t}
        />
      );
      case 3: return !voicesConfirmed ? (
        <VoiceAssignmentStep
          characters={characters} systemVoices={systemVoices} availableVoices={availableVoices}
          playingVoiceId={playingVoiceId} loadingVoiceId={loadingVoiceId}
          isRecommendingVoices={isRecommendingVoices} isAnalyzingCharacters={isAnalyzingCharacters}
          generatingVoicesProgress={generatingVoicesProgress} scriptSections={scriptSections}
          voicePickerCharIndex={voicePickerCharIndex} onVoicePickerOpen={setVoicePickerCharIndex}
          onAssignVoice={assignVoiceToCharacter} onPlayVoice={playVoiceSample}
          onGenerateAllVoices={generateVoicesForAll} onCreateVoice={handleCreateVoice}
          onVoicesUpdated={setAvailableVoices}
        />
      ) : (
        <VoiceGenerationProgress
          scriptSections={scriptSections} production={production}
          onGenerateSection={async (section) => {
            const result = await generateVoiceForSection(section);
            setProduction(prev => {
              const allDone = scriptSections.every(s =>
                prev.voiceGeneration.sectionStatus[s.id]?.status === 'completed'
              );
              if (allDone && scriptSections.length > 0) {
                return { ...prev, voiceGeneration: { ...prev.voiceGeneration, status: 'completed', progress: 100, currentChunk: undefined } };
              }
              return prev;
            });
            return result;
          }}
          onClearAndRegenSection={async (sectionId, section) => {
            clearSectionVoice(sectionId);
            await generateVoiceForSection(section);
            setProduction(prev => {
              const allDone = scriptSections.every(s =>
                prev.voiceGeneration.sectionStatus[s.id]?.status === 'completed'
              );
              if (allDone && scriptSections.length > 0) {
                return { ...prev, voiceGeneration: { ...prev.voiceGeneration, status: 'completed', progress: 100, currentChunk: undefined } };
              }
              return prev;
            });
          }}
          onGenerateAll={performVoiceGeneration}
          onRegenerateLine={regenerateVoiceForLine}
          regeneratingLineId={regeneratingLineId}
          listenedSegments={listenedSegments}
          onSegmentListened={(segId) => setListenedSegments(prev => new Set(prev).add(segId))}
        />
      );
      case 4: return renderMediaProductionStep();
      case 5: return (
        <MixingStep production={production} onRetryMixing={performMixing} downloadTitle={title || 'episode-audio'} hasVisualContent={spec?.hasVisualContent} />
      );
      case 6: return renderSaveStep();
      default: return null;
    }
  };

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="rounded-3xl w-full max-w-4xl max-h-[90vh] overflow-hidden flex flex-col animate-slide-up border border-t-border" style={{ background: 'var(--t-bg-base)' }}>
        {/* Header */}
        <div className="px-8 py-5 flex items-center justify-between border-b border-t-border">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-xl flex items-center justify-center" style={{ background: `${theme.primary}30` }}><ReligionIcon size={24} color={theme.primaryLight} /></div>
            <div>
              <h2 className="text-xl font-serif text-t-text1">{t.episodeEditor.createTitle}</h2>
              <div className="flex items-center gap-2">
                <p className="text-sm text-t-text3">{project.title} · {t.projectCreator.step} {currentStep} / {STEPS.length} · {STEPS[currentStep - 1]?.title}</p>
                {currentStep === 2 && totalLineCount > 0 && (
                  <div className="flex items-center gap-1.5 flex-shrink-0">
                    <div className="w-16 sm:w-20 h-1.5 rounded-full bg-t-border overflow-hidden">
                      <div className="h-full rounded-full transition-all duration-300" style={{ width: `${Math.min((totalLineCount / MAX_SCRIPT_LINES) * 100, 100)}%`, background: totalLineCount >= MAX_SCRIPT_LINES ? '#ef4444' : totalLineCount >= MAX_SCRIPT_LINES * 0.8 ? '#f59e0b' : theme.primary }} />
                    </div>
                    <span className={`text-[10px] tabular-nums ${totalLineCount >= MAX_SCRIPT_LINES ? 'text-red-500' : totalLineCount >= MAX_SCRIPT_LINES * 0.8 ? 'text-amber-500' : 'text-t-text3/60'}`}>{totalLineCount}/{MAX_SCRIPT_LINES}</span>
                  </div>
                )}
              </div>
            </div>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-t-card-hover rounded-lg transition-colors"><X className="text-t-text3" size={24} /></button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-auto px-8 py-8">{renderStepContent()}</div>

        {/* Progress Bar */}
        <div className="relative h-1.5 bg-t-card">
          <div className="absolute inset-y-0 left-0 transition-all duration-500" style={{ width: `${(currentStep / STEPS.length) * 100}%`, background: `linear-gradient(90deg, ${theme.primary}, ${theme.primaryLight})` }} />
        </div>

        {/* Footer */}
        <div className="px-8 py-5 border-t border-t-border flex items-center justify-between">
          <button onClick={currentStep === 1 ? onClose : handleBack} className="flex items-center gap-2 px-5 py-2.5 rounded-lg text-base text-t-text2 hover:text-t-text1 hover:bg-t-card transition-colors">
            <ChevronLeft size={22} />{currentStep === 1 ? t.projectCreator.buttons.cancel : t.projectCreator.buttons.back}
          </button>
          <div className="flex items-center gap-3">
            {currentStep >= 2 && scriptSections.length > 0 && (
              <button onClick={handleSave} className="flex items-center gap-2 px-5 py-2.5 rounded-lg text-base text-t-text3 hover:text-t-text1 hover:bg-t-card-hover transition-colors border border-t-border">{language === 'zh' ? '跳过，稍后继续' : 'Skip for now'}</button>
            )}
            {currentStep === 3 && !voicesConfirmed && (
              <button onClick={startVoiceGeneration} disabled={characters.length === 0 || characters.some(c => !c.assignedVoiceId)} className="flex items-center gap-2 px-8 py-2.5 rounded-lg text-base text-t-text1 font-medium transition-all hover:scale-105 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:scale-100" style={{ background: theme.primary }}>
                <Mic2 size={22} />{language === 'zh' ? '确认并开始语音合成' : 'Confirm & Start Voice Synthesis'}
              </button>
            )}
            {currentStep === 4 && !mediaSelectionsConfirmed && (
              <button onClick={() => performMediaProduction()} className="flex items-center gap-2 px-8 py-2.5 rounded-lg text-base text-t-text1 font-medium transition-all hover:scale-105" style={{ background: theme.primary }}>
                <Wand2 size={22} />{language === 'zh' ? '确认并开始制作' : 'Confirm & Start Production'}
              </button>
            )}
            {currentStep < STEPS.length ? (
              canProceed() && (
                <button onClick={handleNext} disabled={isProcessingNext} className={`flex items-center gap-2 px-8 py-2.5 rounded-lg text-base text-t-text1 font-medium transition-all hover:scale-105 ${isProcessingNext ? 'animate-pulse' : ''}`} style={{ background: theme.primary }}>
                  {isProcessingNext ? (<><Loader2 size={22} className="animate-spin" />{t.common.loading}</>) : (<>{currentStep >= 2 ? (language === 'zh' ? '确认' : 'Approve') : t.projectCreator.buttons.next}<ChevronRight size={22} /></>)}
                </button>
              )
            ) : (
              <button onClick={handleSave} className="flex items-center gap-2 px-8 py-2.5 rounded-lg text-base font-medium transition-all hover:scale-105" style={{ background: theme.accent, color: theme.primaryDark }}>
                <Save size={22} />{t.episodeEditor.buttons.create}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
