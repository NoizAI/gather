import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { useTheme } from '../contexts/ThemeContext';
import { useLanguage } from '../i18n/LanguageContext';
import { Episode, Project, ScriptSection, EpisodeCharacter, VoiceCharacter, isValidSpeaker } from '../types';
import {
  ChevronLeft, ChevronRight, Check, X, Loader2,
  Music, Volume2, Image, Save,
  Mic2, Wand2, FileText,
} from 'lucide-react';
import { ReligionIconMap } from './icons/ReligionIcons';
import * as api from '../services/api';
import { loadVoiceCharacters, loadVoiceCharactersFromCloud, addVoiceCharacter, saveVoiceCharacters } from '../utils/voiceStorage';
import type { SectionVoiceAudio, SectionVoiceStatus, ProductionProgress, MixedAudioOutput } from './ProjectCreator/reducer';
import { loadMediaItems, getMediaByType, getMediaByProject } from '../utils/mediaStorage';
import type { MediaItem } from '../types';
import { MediaPickerModal, findBestMatch, PRESET_BGM_LIST } from './MediaPickerModal';
import type { MediaPickerResult } from './MediaPickerModal';
import { analyzeScriptCharacters } from '../services/llm';

import {
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

interface EpisodeEditorProps {
  episode?: Episode;
  project: Project;
  onSave: (episode: Omit<Episode, 'id' | 'createdAt' | 'updatedAt'>) => void;
  onClose: () => void;
}

const initialProductionProgress: ProductionProgress = {
  voiceGeneration: { status: 'idle', progress: 0, sectionStatus: {} },
  mediaProduction: { status: 'idle', progress: 0 },
  mixingEditing: { status: 'idle', progress: 0 },
};

const MAX_SCRIPT_LINES = 100;

export function EpisodeEditor({ episode, project, onSave, onClose }: EpisodeEditorProps) {
  const { theme, religion } = useTheme();
  const { t, language } = useLanguage();
  const [currentStep, setCurrentStep] = useState(1);

  const ReligionIcon = ReligionIconMap[religion];
  const spec = project.spec;

  // Basic info
  const [title, setTitle] = useState(episode?.title || '');
  const [description, setDescription] = useState(episode?.description || '');
  const [notes, setNotes] = useState(episode?.notes || '');

  // Script sections (pre-populated from existing episode)
  const [scriptSections, setScriptSections] = useState<ScriptSection[]>(episode?.scriptSections || []);
  const [editingSection, setEditingSection] = useState<string | null>(
    episode?.scriptSections?.[0]?.id || null
  );
  const [characters, setCharacters] = useState<CharacterForVoice[]>(() => {
    if (episode?.characters) {
      return episode.characters.map(c => ({
        name: c.name,
        description: c.description,
        assignedVoiceId: c.assignedVoiceId,
        tags: c.tags,
        voiceDescription: c.voiceDescription,
      }));
    }
    return [];
  });

  // UI state
  const [isProcessingNext, setIsProcessingNext] = useState(false);

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

  // 5-step workflow for episode editing
  const STEPS = [
    { id: 1, title: language === 'zh' ? '编辑信息' : 'Edit Info', description: language === 'zh' ? '编辑脚本和基本信息' : 'Edit script and basic info' },
    { id: 2, title: language === 'zh' ? '语音生成' : 'Voice Generation', description: language === 'zh' ? '逐段生成语音' : 'Generate voice for each section' },
    { id: 3, title: language === 'zh' ? '媒体制作' : 'Media Production', description: language === 'zh' ? '音乐、音效和图片' : 'Music, sound effects, and images' },
    { id: 4, title: language === 'zh' ? '混音编辑' : 'Mixing & Editing', description: language === 'zh' ? '混音和时间轴编辑' : 'Mixing and timeline editing' },
    { id: 5, title: language === 'zh' ? '保存' : 'Save', description: language === 'zh' ? '确认并保存' : 'Confirm and save' },
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
    setAvailableVoices(loadVoiceCharacters());
    loadVoiceCharactersFromCloud()
      .then(voices => { if (voices.length > 0) setAvailableVoices(voices); })
      .catch(err => console.error('Failed to load voices from cloud:', err));
    api.getVoices()
      .then(voices => setSystemVoices(voices))
      .catch(err => console.error('Failed to load system voices:', err));
  }, []);

  useEffect(() => {
    if (currentStep !== 2 && audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
      setPlayingVoiceId(null);
    }
  }, [currentStep]);

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
    const existingChars = characters;
    const extractedChars: CharacterForVoice[] = Array.from(speakerSet).map(name => {
      const existing = existingChars.find(c => c.name === name);
      return existing || { name, description: '' };
    });
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
  }, [scriptSections, characters, language]);

  const assignVoiceToCharacter = useCallback((characterIndex: number, voiceId: string) => {
    setCharacters(chars => chars.map((char, idx) => idx === characterIndex ? { ...char, assignedVoiceId: voiceId } : char));
  }, []);

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
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
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
        const preset = PRESET_BGM_LIST[0];
        setBgmSelection({ source: 'preset', prompt: language === 'zh' ? preset.description.zh : preset.description.en, audioUrl: preset.url, presetId: preset.id });
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
  }, [spec, scriptSections, project.id, language]);

  // ============================================================
  // Save episode
  // ============================================================
  const handleSave = () => {
    if (!title.trim()) { alert(t.episodeEditor.validation.titleRequired); return; }
    const episodeCharacters: EpisodeCharacter[] = characters.map(char => ({
      name: char.name, description: char.description, assignedVoiceId: char.assignedVoiceId, tags: char.tags,
    }));
    const mixedOutput = production.mixingEditing.output;
    let stage: 'planning' | 'scripting' | 'recording' | 'editing' | 'review' | 'published' = 'scripting';
    if (mixedOutput?.audioData) stage = 'review';
    else if (production.voiceGeneration.status === 'completed') stage = 'editing';
    else if (scriptSections.length > 0) stage = 'scripting';

    onSave({
      title,
      subtitle: episode?.subtitle,
      description,
      script: '',
      scriptSections,
      characters: episodeCharacters,
      audioData: mixedOutput?.audioData,
      audioMimeType: mixedOutput?.mimeType,
      audioDurationMs: mixedOutput?.durationMs,
      audioUrl: episode?.audioUrl,
      duration: episode?.duration,
      stage,
      notes,
    });
  };

  // ============================================================
  // Navigation
  // ============================================================
  const canProceed = () => {
    switch (currentStep) {
      case 1: return scriptSections.length > 0;
      case 2: return voicesConfirmed && production.voiceGeneration.status === 'completed';
      case 3: return production.mediaProduction.status === 'completed';
      case 4: return production.mixingEditing.status === 'completed';
      default: return true;
    }
  };

  const handleNext = async () => {
    if (currentStep === 1 && scriptSections.length > 0) {
      setIsProcessingNext(true);
      extractCharacters();
      await new Promise(resolve => setTimeout(resolve, 300));
      setIsProcessingNext(false);
      setCurrentStep(2);
      setVoicesConfirmed(false);
      return;
    }
    if (currentStep === 2 && production.voiceGeneration.status === 'completed') {
      setCurrentStep(3);
      setMediaSelectionsConfirmed(false);
      setTimeout(() => initializeMediaSelections(), 100);
      return;
    }
    if (currentStep === 3 && production.mediaProduction.status === 'completed') {
      setCurrentStep(4);
      setTimeout(() => performMixing(), 100);
      return;
    }
    if (currentStep === 4 && production.mixingEditing.status === 'completed') {
      setCurrentStep(5);
      return;
    }
    if (currentStep < STEPS.length) setCurrentStep(currentStep + 1);
  };

  const handleBack = () => { if (currentStep > 1) setCurrentStep(currentStep - 1); };

  // ============================================================
  // Render: Media Production Step
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
                  ) : (
                    <p className="text-sm text-t-text3">{language === 'zh' ? '点击选择背景音乐' : 'Click to select BGM'}</p>
                  )}
                </div>
                <ChevronRight size={16} className="text-t-text3 group-hover:text-t-text1" />
              </div>
            </div>
          )}

          {hasSfx && sfxNeeds.length > 0 && (
            <div className="space-y-2">
              <div className="flex items-center gap-2"><Volume2 size={16} style={{ color: theme.primaryLight }} /><span className="text-sm font-medium text-t-text2">{language === 'zh' ? '音效' : 'Sound Effects'}</span></div>
              {sfxNeeds.map(sfx => {
                const key = `${sfx.sectionId}-${sfx.itemId}`;
                const sel = sfxSelections[key];
                return (
                  <div key={key} className="flex items-center gap-3 p-3 rounded-xl border border-t-border cursor-pointer transition-all hover:border-t-border" style={{ background: 'var(--t-bg-card)' }} onClick={() => setMediaPickerOpen(key)}>
                    <div className="w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0" style={{ background: `${theme.primary}15` }}><Volume2 size={14} style={{ color: theme.primaryLight }} /></div>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs text-t-text3 truncate">{sfx.sectionName}</p>
                      <p className="text-sm text-t-text1 truncate">{sfx.prompt}</p>
                      {sel && <p className="text-[10px] text-t-text3">{sel.source === 'library' ? (language === 'zh' ? '媒体库' : 'Library') : sel.source === 'generate' ? (language === 'zh' ? '将生成' : 'Will generate') : sel.source}</p>}
                    </div>
                    <ChevronRight size={14} className="text-t-text3" />
                  </div>
                );
              })}
            </div>
          )}

          {!hasBgm && !hasSfx && !hasImages && (
            <div className="text-center py-8 text-t-text3">
              <p>{language === 'zh' ? '此项目未启用媒体功能' : 'No media features enabled for this project'}</p>
            </div>
          )}

          {mediaPickerOpen === 'bgm' && (
            <MediaPickerModal
              mode="bgm"
              prompt={bgmSelection?.prompt || spec?.toneAndExpression || ''}
              libraryItems={bgmLibraryItems}
              preSelectedId={bgmSelection?.source === 'library' ? bgmSelection.mediaItem?.id : undefined}
              preSelectedPresetId={bgmSelection?.source === 'preset' ? bgmSelection.presetId : undefined}
              projectItemIds={projectItemIds}
              onConfirm={(result) => { setBgmSelection(result); setMediaPickerOpen(null); }}
              onClose={() => setMediaPickerOpen(null)}
            />
          )}
          {mediaPickerOpen && mediaPickerOpen !== 'bgm' && (() => {
            const key = mediaPickerOpen;
            const need = sfxNeeds.find(n => `${n.sectionId}-${n.itemId}` === key);
            if (!need) return null;
            const sel = sfxSelections[key];
            return (
              <MediaPickerModal
                mode="sfx"
                prompt={need.prompt}
                desiredDuration={5}
                libraryItems={sfxLibraryItems}
                preSelectedId={sel?.source === 'library' ? sel.mediaItem?.id : undefined}
                projectItemIds={projectItemIds}
                onConfirm={(result) => { setSfxSelections(prev => ({ ...prev, [key]: result })); setMediaPickerOpen(null); }}
                onClose={() => setMediaPickerOpen(null)}
              />
            );
          })()}
        </div>
      );
    }

    // Production in progress or completed
    if (mediaProduction.status === 'processing') {
      return (
        <div className="text-center py-12">
          <Loader2 size={48} className="mx-auto mb-4 animate-spin" style={{ color: theme.primaryLight }} />
          <p className="text-t-text1 font-medium">{mediaProduction.currentTask || (language === 'zh' ? '制作中...' : 'Producing...')}</p>
          <div className="w-48 mx-auto mt-4 h-2 rounded-full bg-t-border overflow-hidden">
            <div className="h-full rounded-full transition-all duration-500" style={{ width: `${mediaProduction.progress}%`, background: theme.primary }} />
          </div>
        </div>
      );
    }

    return (
      <div className="space-y-6">
        <div className="text-center py-4">
          <div className="w-16 h-16 mx-auto mb-4 rounded-full flex items-center justify-center" style={{ background: `${theme.primary}20` }}>
            <Check size={32} style={{ color: theme.primaryLight }} />
          </div>
          <h3 className="text-xl font-medium text-t-text1 mb-2">{language === 'zh' ? '媒体制作完成' : 'Media Production Complete'}</h3>
        </div>
        <MediaPreviewSection production={production} onRegenMedia={handleRegenMedia} regeneratingId={regeneratingId} />
      </div>
    );
  };

  // ============================================================
  // Render: Save Step
  // ============================================================
  const renderSaveStep = () => (
    <div className="space-y-8">
      <div className="text-center py-4">
        <div className="w-20 h-20 mx-auto mb-5 rounded-full flex items-center justify-center" style={{ background: `${theme.primary}30` }}>
          <Check size={40} style={{ color: theme.primaryLight }} />
        </div>
        <h3 className="text-xl font-medium text-t-text1 mb-2">{language === 'zh' ? '准备就绪！' : 'Ready to Save!'}</h3>
        <p className="text-base text-t-text3">{language === 'zh' ? '确认以下信息并保存' : 'Confirm the details below and save'}</p>
      </div>
      <div className="rounded-xl p-6 border border-t-border" style={{ background: `${theme.primary}10` }}>
        <div className="flex items-center gap-4 mb-5">
          <div className="w-14 h-14 rounded-xl flex items-center justify-center" style={{ background: `${theme.primary}30` }}>
            <ReligionIcon size={28} color={theme.primaryLight} />
          </div>
          <div className="flex-1">
            <h3 className="text-2xl font-serif text-t-text1">{title}</h3>
            <p className="text-base text-t-text3">{project.title}</p>
          </div>
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
      <p className="text-center text-t-text3 text-sm">{language === 'zh' ? '点击下方按钮保存' : 'Click the button below to save'}</p>
    </div>
  );

  // ============================================================
  // Render: Info + Script editing step (Step 1)
  // ============================================================
  const renderInfoAndScriptStep = () => (
    <div className="space-y-6">
      {/* Basic Info */}
      <div className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-t-text2 mb-2">
            {t.episodeEditor.form.title} <span className="text-red-400">*</span>
          </label>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={t.episodeEditor.form.titlePlaceholder}
            className="w-full px-4 py-3 rounded-xl border border-t-border bg-t-card text-t-text1 placeholder-t-text3 focus:outline-none focus:border-t-border transition-all"
          />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-t-text2 mb-2">{t.episodeEditor.form.description}</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t.episodeEditor.form.descriptionPlaceholder}
              rows={2}
              className="w-full px-4 py-3 rounded-xl border border-t-border bg-t-card text-t-text1 placeholder-t-text3 focus:outline-none focus:border-t-border transition-all resize-none"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-t-text2 mb-2">{t.episodeEditor.form.notesDesc || (language === 'zh' ? '备注' : 'Notes')}</label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder={t.episodeEditor.form.notesPlaceholder}
              rows={2}
              className="w-full px-4 py-3 rounded-xl border border-t-border bg-t-card text-t-text1 placeholder-t-text3 focus:outline-none focus:border-t-border transition-all resize-none"
            />
          </div>
        </div>
      </div>

      {/* Divider */}
      <div className="flex items-center gap-3">
        <div className="flex-1 border-t border-t-border" />
        <span className="text-xs text-t-text3 flex items-center gap-1"><FileText size={12} /> {language === 'zh' ? '脚本编辑' : 'Script Editor'}</span>
        <div className="flex-1 border-t border-t-border" />
      </div>

      {/* Script Editor */}
      <ScriptEditorStep
        scriptSections={scriptSections}
        editingSection={editingSection}
        onEditingSectionChange={setEditingSection}
        isGeneratingScript={false}
        streamingText=""
        onGenerateScript={() => {}}
        actions={scriptActions}
        knownSpeakers={knownSpeakers}
        totalLineCount={totalLineCount}
        maxScriptLines={MAX_SCRIPT_LINES}
        hasVisualContent={spec?.hasVisualContent}
        hasAudio={spec?.addBgm || spec?.addSoundEffects}
        t={t}
        hideGenerateButton
      />
    </div>
  );

  // ============================================================
  // Main render
  // ============================================================
  const renderStepContent = () => {
    switch (currentStep) {
      case 1: return renderInfoAndScriptStep();
      case 2: return !voicesConfirmed ? (
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
      case 3: return renderMediaProductionStep();
      case 4: return (
        <MixingStep production={production} onRetryMixing={performMixing} downloadTitle={title || 'episode-audio'} hasVisualContent={spec?.hasVisualContent} />
      );
      case 5: return renderSaveStep();
      default: return null;
    }
  };

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="rounded-3xl w-full max-w-4xl max-h-[90vh] overflow-hidden flex flex-col animate-slide-up border border-t-border" style={{ background: 'var(--t-bg-base)' }}>
        {/* Header */}
        <div className="px-8 py-5 flex items-center justify-between border-b border-t-border">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-xl flex items-center justify-center" style={{ background: `${theme.primary}30` }}>
              <ReligionIcon size={24} color={theme.primaryLight} />
            </div>
            <div>
              <h2 className="text-xl font-serif text-t-text1">{episode ? t.episodeEditor.editTitle : t.episodeEditor.createTitle}</h2>
              <div className="flex items-center gap-2">
                <p className="text-sm text-t-text3">{project.title} · {t.projectCreator.step} {currentStep} / {STEPS.length} · {STEPS[currentStep - 1]?.title}</p>
                {currentStep === 1 && totalLineCount > 0 && (
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
            <ChevronLeft size={22} />{currentStep === 1 ? t.episodeEditor.buttons.cancel : t.projectCreator.buttons.back}
          </button>
          <div className="flex items-center gap-3">
            {currentStep >= 1 && scriptSections.length > 0 && currentStep < STEPS.length && (
              <button onClick={handleSave} className="flex items-center gap-2 px-5 py-2.5 rounded-lg text-base text-t-text3 hover:text-t-text1 hover:bg-t-card-hover transition-colors border border-t-border">{language === 'zh' ? '跳过，直接保存' : 'Skip, save now'}</button>
            )}
            {currentStep === 2 && !voicesConfirmed && (
              <button onClick={startVoiceGeneration} disabled={characters.length === 0 || characters.some(c => !c.assignedVoiceId)} className="flex items-center gap-2 px-8 py-2.5 rounded-lg text-base text-t-text1 font-medium transition-all hover:scale-105 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:scale-100" style={{ background: theme.primary }}>
                <Mic2 size={22} />{language === 'zh' ? '确认并开始语音合成' : 'Confirm & Start Voice Synthesis'}
              </button>
            )}
            {currentStep === 3 && !mediaSelectionsConfirmed && (
              <button onClick={() => performMediaProduction()} className="flex items-center gap-2 px-8 py-2.5 rounded-lg text-base text-t-text1 font-medium transition-all hover:scale-105" style={{ background: theme.primary }}>
                <Wand2 size={22} />{language === 'zh' ? '确认并开始制作' : 'Confirm & Start Production'}
              </button>
            )}
            {currentStep < STEPS.length ? (
              canProceed() && (
                <button onClick={handleNext} disabled={isProcessingNext} className={`flex items-center gap-2 px-8 py-2.5 rounded-lg text-base text-t-text1 font-medium transition-all hover:scale-105 ${isProcessingNext ? 'animate-pulse' : ''}`} style={{ background: theme.primary }}>
                  {isProcessingNext ? (<><Loader2 size={22} className="animate-spin" />{t.common.loading}</>) : (<>{language === 'zh' ? '确认' : 'Approve'}<ChevronRight size={22} /></>)}
                </button>
              )
            ) : (
              <button onClick={handleSave} className="flex items-center gap-2 px-8 py-2.5 rounded-lg text-base font-medium transition-all hover:scale-105" style={{ background: theme.accent, color: theme.primaryDark }}>
                <Save size={22} />{episode ? t.episodeEditor.buttons.save : t.episodeEditor.buttons.create}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
