import { useState, useRef, useCallback, useEffect, useReducer, useMemo } from 'react';
import { useTheme } from '../contexts/ThemeContext';
import { useProjects } from '../contexts/ProjectContext';
import { useLanguage } from '../i18n/LanguageContext';
import { VoiceCharacter, ScriptSection, EpisodeCharacter, isValidSpeaker } from '../types';
import { 
  ChevronLeft, ChevronRight, ChevronDown, Check, X, Upload, FileText, 
  Sparkles, Plus, Play, Pause, User, Loader2,
  Music, Volume2, Image, RefreshCw, Save,
  BookOpen, Mic2, Wand2, GraduationCap,
  LucideIcon, Square, Users, Headphones, Mic, MessageSquare, 
  Newspaper, Library, Video,
} from 'lucide-react';
import { ReligionIconMap } from './icons/ReligionIcons';
import { filterValidFiles, collectAnalysisContent } from '../utils/fileUtils';
import { parseStreamingScriptSections } from '../utils/partialJsonParser';
import { 
  buildSpecAnalysisPrompt, 
  buildScriptGenerationPrompt,
  buildCreativeContextExtractionPrompt,
  parseScriptGenerationResponse,
  SpecAnalysisResult,
  CreativeContextExtraction
} from '../services/llm/prompts';
import type { BgmRecommendation } from '../services/llm/prompts';
import { analyzeScriptCharacters } from '../services/llm';
import * as api from '../services/api';
import { 
  projectCreatorReducer, 
  initialState, 
  actions,
  SpecData,
  saveDraft,
  loadDraft,
  clearDraft
} from './ProjectCreator/reducer';
import { PROJECT_TEMPLATES } from './ProjectCreator/templates';
import { loadVoiceCharacters, loadVoiceCharactersFromCloud, addVoiceCharacter } from '../utils/voiceStorage';
import { loadMediaItems, saveMediaItems } from '../utils/mediaStorage';
import { PRESET_BGM_LIST, MediaPickerModal } from './MediaPickerModal';
import type { MediaPickerResult } from './MediaPickerModal';
import type { LandingData } from './Landing';
import { VoicePickerModal } from './VoicePickerModal';
import {
  ScriptEditorStep,
  MixingStep,
  useVoiceGeneration,
  useMediaProduction,
  useMixingPipeline,
} from './ProjectCreator/shared';
import type { ScriptEditorActions } from './ProjectCreator/shared';

// Icon mapping for templates (basic + advanced)
const TemplateIconMap: Record<string, LucideIcon> = {
  // Basic templates
  BookOpen,
  Mic2,
  GraduationCap,
  // Advanced templates
  Users,
  Headphones,
  Mic,
  MessageSquare,
  Newspaper,
  Library,
  Video,
};

interface ProjectCreatorProps {
  onClose: () => void;
  onSuccess: (projectId?: string) => void;
  initialData?: LandingData;
  creativeContext?: string;
}

export function ProjectCreator({ onClose, onSuccess, initialData, creativeContext }: ProjectCreatorProps) {
  const { theme, religion } = useTheme();
  const { createProject } = useProjects();
  const { t, language } = useLanguage();
  // Start at step 2 if initialData or creativeContext is provided
  const [currentStep, setCurrentStep] = useState(initialData || creativeContext ? 2 : 1);
  
  // Unified state management with reducer
  const [state, dispatch] = useReducer(projectCreatorReducer, initialState);
  const { 
    selectedTemplate, 
    selectedTemplateId,
    spec: specData, 
    contentInput,
    scriptSections, 
    characters: extractedCharacters,
    production 
  } = state;
  
  // Creative context ref for script generation
  const creativeContextRef = useRef<string | undefined>(creativeContext);
  const [isExtractingCreativeContext, setIsExtractingCreativeContext] = useState(!!creativeContext);

  // Local UI state
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [showSubtitle, setShowSubtitle] = useState(false);
  const [showOptionalSpecFields, setShowOptionalSpecFields] = useState(false);
  const [isGeneratingScript, setIsGeneratingScript] = useState(false);
  const [editingSection, setEditingSection] = useState<string | null>(null);
  const [streamingText, setStreamingText] = useState<string>('');
  // Parsed streaming sections for progressive UI rendering
  const [streamingParsed, setStreamingParsed] = useState<{
    completeSections: ScriptSection[];
    partialSection: Partial<ScriptSection> | null;
  }>({ completeSections: [], partialSection: null });
  // Voice characters - for character voice assignment UI
  const [availableVoices, setAvailableVoices] = useState<VoiceCharacter[]>([]);
  // Track if user has confirmed voice assignments before synthesis
  const [voicesConfirmed, setVoicesConfirmed] = useState(false);
  // System voices from backend (Gemini TTS)
  const [systemVoices, setSystemVoices] = useState<api.Voice[]>([]);
  // Voice preview state
  const [playingVoiceId, setPlayingVoiceId] = useState<string | null>(null);
  const [loadingVoiceId, setLoadingVoiceId] = useState<string | null>(null);
  const [isRecommendingVoices, setIsRecommendingVoices] = useState(false);
  const [isAnalyzingCharacters, setIsAnalyzingCharacters] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  // Voice picker modal state
  const [voicePickerCharIndex, setVoicePickerCharIndex] = useState<number | null>(null);
  // Collapsed sections (default is expanded for completed sections)
  const [collapsedVoiceSections, setCollapsedVoiceSections] = useState<Set<string>>(new Set());
  // Track currently playing audio segment: "sectionId-audioIndex"
  const [playingSegmentId, setPlayingSegmentId] = useState<string | null>(null);
  const segmentAudioRef = useRef<HTMLAudioElement | null>(null);
  // Track segments that have been fully listened to: "sectionId-audioIndex"
  const [listenedSegments, setListenedSegments] = useState<Set<string>>(new Set());
  // Track per-line regeneration in progress: "sectionId-audioIndex"
  const [regeneratingLineId, setRegeneratingLineId] = useState<string | null>(null);
  // Warning dialog when proceeding without listening to all
  const [showListenWarning, setShowListenWarning] = useState(false);
  
  // Media production preview playback
  const [playingMediaId, setPlayingMediaId] = useState<string | null>(null);
  const mediaAudioRef = useRef<HTMLAudioElement | null>(null);
  const [regeneratingId, setRegeneratingId] = useState<string | null>(null);
  
  // AI-recommended BGM from script generation
  const [bgmRecommendation, setBgmRecommendation] = useState<BgmRecommendation | null>(null);
  
  // Media selection state (Step 6 - pre-production phase)
  const [mediaSelectionsConfirmed, setMediaSelectionsConfirmed] = useState(false);
  const [bgmSelection, setBgmSelection] = useState<MediaPickerResult | null>(null);
  const [mediaPickerOpen, setMediaPickerOpen] = useState<'bgm' | null>(null);
  
  const performMixingRef = useRef<() => Promise<void>>(() => Promise.resolve());
  // Keep latest state in a ref so async callbacks avoid stale closures
  const stateRef = useRef(state);
  stateRef.current = state;
  const [showProgressTooltip, setShowProgressTooltip] = useState(false);
  const [hoveredStep, setHoveredStep] = useState<number | null>(null);
  const [isProcessingNext, setIsProcessingNext] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  // Draft persistence
  const [draftBanner, setDraftBanner] = useState<{ visible: boolean; savedAt: number } | null>(null);
  const draftSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Maximum number of script lines allowed (matches server-side batch limit)
  const MAX_SCRIPT_LINES = 100;
  
  // Compute total line count across all sections
  const totalLineCount = useMemo(() => {
    return scriptSections.reduce((total, section) => {
      return total + section.timeline.reduce((sectionTotal, item) => {
        return sectionTotal + (item.lines?.length || 0);
      }, 0);
    }, 0);
  }, [scriptSections]);

  // Compute known speaker names from characters + script lines (for dropdown selection)
  const knownSpeakers = useMemo(() => {
    const names = new Set<string>();
    // From extracted characters
    extractedCharacters.forEach(c => { if (c.name) names.add(c.name); });
    // From script lines (so dropdown works during script editing before character extraction)
    scriptSections.forEach(section => {
      section.timeline.forEach(item => {
        (item.lines || []).forEach(line => {
          if (isValidSpeaker(line.speaker)) names.add(line.speaker.trim());
        });
      });
    });
    return Array.from(names);
  }, [extractedCharacters, scriptSections]);

  const ReligionIcon = ReligionIconMap[religion];

  // New 8-step workflow
  const STEPS = [
    { 
      id: 1, 
      title: language === 'zh' ? '选择模板' : 'Select Template',
      description: language === 'zh' ? '选择项目类型和预设配置' : 'Choose project type and preset configuration'
    },
    { 
      id: 2, 
      title: language === 'zh' ? '项目规格' : 'Project Specification',
      description: language === 'zh' ? '确认并编辑项目规格' : 'Confirm and edit project specifications'
    },
    { 
      id: 3, 
      title: language === 'zh' ? '内容输入' : 'Content Input',
      description: language === 'zh' ? '上传或输入您的内容' : 'Upload or enter your content'
    },
    { 
      id: 4, 
      title: language === 'zh' ? '脚本生成' : 'Script Generation',
      description: language === 'zh' ? '生成时间轴脚本' : 'Generate timeline scripts'
    },
    { 
      id: 5, 
      title: language === 'zh' ? '语音生成' : 'Voice Generation',
      description: language === 'zh' ? '逐段生成语音' : 'Chunk-by-chunk voice generation'
    },
    { 
      id: 6, 
      title: language === 'zh' ? '媒体制作' : 'Media Production',
      description: language === 'zh' ? '音乐、音效和图片' : 'Music, sound effects, and images'
    },
    { 
      id: 7, 
      title: language === 'zh' ? '混音编辑' : 'Mixing & Editing',
      description: language === 'zh' ? '混音和时间轴编辑' : 'Mixing and timeline editing'
    },
    { 
      id: 8, 
      title: language === 'zh' ? '保存项目' : 'Save Project',
      description: language === 'zh' ? '确认并保存' : 'Confirm and save'
    },
  ];

  // Template selection
  const handleSelectTemplate = useCallback((templateId: string) => {
    dispatch(actions.selectTemplate(templateId));
  }, []);

  // File upload handler - supports multiple files
  const handleFileUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (files && files.length > 0) {
      const validFiles = filterValidFiles(files);
      if (validFiles.length > 0) {
        dispatch(actions.addUploadedFiles(validFiles));
      } else {
        alert(t.projectCreator?.errors?.uploadFileType || 'Invalid file type');
      }
    }
  };

  // Remove uploaded file
  const removeUploadedFile = (index: number) => {
    dispatch(actions.removeUploadedFile(index));
  };

  // Text content change
  const handleTextContentChange = useCallback((content: string) => {
    dispatch(actions.setTextContent(content));
  }, []);

  // Drag and drop handlers
  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);

    const files = e.dataTransfer.files;
    if (files && files.length > 0) {
      const validFiles = filterValidFiles(files);
      if (validFiles.length > 0) {
        dispatch(actions.addUploadedFiles(validFiles));
      } else {
        alert(t.projectCreator?.errors?.uploadFileType || 'Invalid file type');
      }
    }
  };

  // Handle API errors with localized messages
  const handleApiError = useCallback((error: unknown) => {
    console.error('API error:', error);
    const message = error instanceof Error ? error.message : String(error);
    alert(message || t.projectCreator.errors.unknownError);
  }, [t]);

  // Analyze with LLM - extracts title and updates spec from content
  const analyzeWithGemini = async () => {
    setIsAnalyzing(true);
    
    try {
      const hasFiles = contentInput.uploadedFiles.length > 0;
      const hasText = contentInput.textContent.trim().length > 0;

      // When both files and text exist, text is treated as user instructions (e.g. "preserve number reading")
      const userInstructions = (hasFiles && hasText) ? contentInput.textContent : undefined;
      const textForCollection = (hasFiles && hasText) ? '' : contentInput.textContent;

      const { text: content, attachments } = await collectAnalysisContent(
        textForCollection, contentInput.uploadedFiles, { returnAttachments: true }
      );

      if (!content.trim() && attachments.length === 0) {
        alert(t.projectCreator?.errors?.inputOrUpload || 'Please input or upload content');
        setIsAnalyzing(false);
        return;
      }

      // Pass current project spec context to help Gemini better understand the content
      const specContext = {
        templateName: selectedTemplate 
          ? (language === 'zh' ? selectedTemplate.nameZh : selectedTemplate.name)
          : undefined,
        targetAudience: specData.targetAudience || undefined,
        formatAndDuration: specData.formatAndDuration || undefined,
        toneAndExpression: specData.toneAndExpression || undefined,
      };

      const prompt = buildSpecAnalysisPrompt(content, specContext, userInstructions);
      
      // Use backend API for text generation (with file attachments for multimodal)
      const responseText = await api.generateText(prompt, { attachments });
      
      // Parse JSON from response
      const jsonMatch = responseText.match(/```(?:json)?\s*([\s\S]*?)```/) || 
                        responseText.match(/\{[\s\S]*\}/);
      const jsonStr = jsonMatch ? (jsonMatch[1] || jsonMatch[0]).trim() : responseText;
      const parsed = JSON.parse(jsonStr) as SpecAnalysisResult;

      // Only update title from analysis, keep template defaults for other fields
      dispatch(actions.setSpec({
        storyTitle: parsed.storyTitle || '',
        subtitle: parsed.subtitle || '',
        // Keep template defaults if set, otherwise use analyzed values
        targetAudience: specData.targetAudience || parsed.targetAudience || '',
        formatAndDuration: specData.formatAndDuration || parsed.formatAndDuration || '',
        toneAndExpression: specData.toneAndExpression || parsed.toneAndExpression || '',
      }));
      
      if (parsed.subtitle) {
        setShowSubtitle(true);
      }
    } catch (error) {
      handleApiError(error);
    } finally {
      setIsAnalyzing(false);
    }
  };

  // Generate script with LLM (streaming)
  const generateScript = async () => {
    setIsGeneratingScript(true);
    setStreamingText(''); // Reset streaming text

    try {
      const hasFiles = contentInput.uploadedFiles.length > 0;
      const hasText = contentInput.textContent.trim().length > 0;

      // When both files and text exist, text is treated as user instructions
      const userInstructions = (hasFiles && hasText) ? contentInput.textContent : undefined;
      const textForCollection = (hasFiles && hasText) ? '' : contentInput.textContent;

      const { text: content, attachments } = await collectAnalysisContent(
        textForCollection, contentInput.uploadedFiles, { includeLabels: false, returnAttachments: true }
      );

      // Include template hints in prompt if available (based on voice count selection)
      const templateHints = selectedTemplate?.promptHints[templateConfig.voiceCount];
      
      const prompt = buildScriptGenerationPrompt(content, {
        title: specData.storyTitle,
        targetAudience: specData.targetAudience,
        formatAndDuration: specData.formatAndDuration,
        toneAndExpression: specData.toneAndExpression,
        addBgm: specData.addBgm,
        addSoundEffects: specData.addSoundEffects,
        hasVisualContent: specData.hasVisualContent,
        // Pass template hints if available
        ...(templateHints && {
          styleHint: templateHints.style,
          structureHint: templateHints.structure,
          voiceDirectionHint: templateHints.voiceDirection,
        }),
      }, userInstructions, creativeContextRef.current);

      // Use backend streaming API for progressive generation (with file attachments)
      const finalText = await api.generateTextStream(
        prompt,
        (chunk) => {
          setStreamingText(chunk.accumulated);
        },
        { attachments }
      );
      
      // Parse JSON from final response (handles both array and object formats)
      const { sections, bgmRecommendation } = parseScriptGenerationResponse(finalText);
      const typedSections = sections as ScriptSection[];
      
      if (typedSections && typedSections.length > 0) {
        dispatch(actions.setScriptSections(typedSections));
        // Auto-expand the first section
        setEditingSection(typedSections[0].id);
      }

      // Use AI-recommended preset BGM if available
      if (bgmRecommendation && specData.addBgm) {
        const preset = PRESET_BGM_LIST.find(p => p.id === bgmRecommendation.presetId) || PRESET_BGM_LIST[0];
        dispatch(actions.setBgmAudio({
          audioUrl: preset.url,
          mimeType: 'audio/wav',
        }));
        // Store recommendation for later use
        setBgmRecommendation(bgmRecommendation);
      }
    } catch (error) {
      handleApiError(error);
    } finally {
      setIsGeneratingScript(false);
      setStreamingText(''); // Clear streaming text after completion
    }
  };

  // Extract characters from script and analyze their tags via LLM
  const extractCharacters = useCallback(() => {
    dispatch(actions.extractCharactersFromScript());
    setAvailableVoices(loadVoiceCharacters());

    // Async: analyze character tags in background (non-blocking)
    const speakers = new Set<string>();
    for (const section of scriptSections) {
      for (const item of section.timeline) {
        if (item.lines) {
          for (const line of item.lines) {
            if (isValidSpeaker(line.speaker)) {
              speakers.add(line.speaker!.trim());
            }
          }
        }
      }
    }
    const charNames = Array.from(speakers);
    if (charNames.length > 0) {
      setIsAnalyzingCharacters(true);
      analyzeScriptCharacters(
        JSON.stringify(scriptSections),
        charNames,
        language === 'zh' ? 'zh' : 'en'
      ).then(tags => {
        dispatch(actions.updateCharacterTags(tags));
      }).catch(err => {
        console.error('Character analysis failed:', err);
      }).finally(() => {
        setIsAnalyzingCharacters(false);
      });
    }
  }, [scriptSections, language]);

  // Assign voice to character
  const assignVoiceToCharacter = useCallback((characterIndex: number, voiceId: string) => {
    dispatch(actions.assignVoiceToCharacter(characterIndex, voiceId));
  }, []);


  // AI generate new voices for all characters using their voiceDescription
  const [generatingVoicesProgress, setGeneratingVoicesProgress] = useState<{ current: number; total: number } | null>(null);
  const generateVoicesForAll = useCallback(async () => {
    // Only generate for characters that have a voiceDescription and no voice assigned yet
    const charsToGenerate = extractedCharacters
      .map((c, idx) => ({ ...c, idx }))
      .filter(c => c.voiceDescription && !c.assignedVoiceId);
    if (charsToGenerate.length === 0) return;

    setIsRecommendingVoices(true);
    setGeneratingVoicesProgress({ current: 0, total: charsToGenerate.length });

    let currentVoices = availableVoices;
    for (let i = 0; i < charsToGenerate.length; i++) {
      const char = charsToGenerate[i];
      setGeneratingVoicesProgress({ current: i + 1, total: charsToGenerate.length });
      try {
        // Design voice using the character's voiceDescription
        const result = await api.designVoice(char.voiceDescription!);
        if (result.previews.length === 0) continue;

        // Take the first preview candidate
        const preview = result.previews[0];
        const dataUrl = `data:${preview.mediaType || 'audio/mpeg'};base64,${preview.audioBase64}`;

        // Save as a new custom voice
        const updatedVoices = addVoiceCharacter(currentVoices, {
          name: char.name,
          description: char.voiceDescription || '',
          refAudioDataUrl: dataUrl,
          audioSampleUrl: dataUrl,
          tags: ['ai-generated'],
        });
        const newVoice = updatedVoices[updatedVoices.length - 1];
        currentVoices = updatedVoices;
        setAvailableVoices(updatedVoices);

        // Auto-assign to character
        dispatch(actions.assignVoiceToCharacter(char.idx, newVoice.id));
      } catch (err) {
        console.error(`Failed to generate voice for ${char.name}:`, err);
      }
    }

    setIsRecommendingVoices(false);
    setGeneratingVoicesProgress(null);
  }, [extractedCharacters, availableVoices]);

  // Check if existing audio for a section still matches the current script + voice assignments
  const isSectionAudioCurrent = (section: ScriptSection): boolean => {
    const status = production.voiceGeneration.sectionStatus[section.id];
    if (!status || status.status !== 'completed' || status.audioSegments.length === 0) {
      return false;
    }

    // Build expected segments from current script + voice assignments
    const expected: Array<{ text: string; speaker: string; voiceId?: string }> = [];
    for (const item of section.timeline) {
      for (const line of item.lines) {
        if (line.line.trim()) {
          const character = extractedCharacters.find(c => c.name === line.speaker);
          expected.push({
            text: line.line,
            speaker: line.speaker || 'Narrator',
            voiceId: character?.assignedVoiceId,
          });
        }
      }
    }

    const existing = status.audioSegments;
    if (expected.length !== existing.length) return false;

    return expected.every((exp, i) =>
      exp.text === existing[i].text &&
      exp.speaker === existing[i].speaker &&
      exp.voiceId === existing[i].voiceId
    );
  };

  // Start voice generation after confirming voice assignments
  const startVoiceGeneration = () => {
    // Smart diff: only clear sections whose content or voice changed
    const sectionsToRegenerate = new Set<string>();

    for (const section of scriptSections) {
      if (!isSectionAudioCurrent(section)) {
        dispatch(actions.clearSectionVoice(section.id));
        sectionsToRegenerate.add(section.id);
        // Clear listened state for changed section
        setListenedSegments(prev => {
          const next = new Set(prev);
          for (const key of prev) {
            if (key.startsWith(`${section.id}-`)) next.delete(key);
          }
          return next;
        });
      }
    }

    // Clean up orphaned sections that no longer exist in the script
    const currentSectionIds = new Set(scriptSections.map(s => s.id));
    for (const sectionId of Object.keys(production.voiceGeneration.sectionStatus)) {
      if (!currentSectionIds.has(sectionId)) {
        dispatch(actions.clearSectionVoice(sectionId));
      }
    }

    setVoicesConfirmed(true);

    if (sectionsToRegenerate.size > 0) {
      performVoiceGeneration(sectionsToRegenerate);
    } else {
      // Nothing changed — keep existing audio, mark completed
      dispatch(actions.updateProductionPhase('voice-generation', 'completed', 100));
    }
  };

  // Play voice sample preview
  const playVoiceSample = async (voiceId: string) => {
    // If same voice is playing, stop it
    if (playingVoiceId === voiceId) {
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
      setPlayingVoiceId(null);
      return;
    }

    // Stop any currently playing audio
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }

    try {
      setLoadingVoiceId(voiceId);
      setPlayingVoiceId(null);
      
      // Check if this is a custom voice with a stored audio sample
      const customVoice = availableVoices.find(v => v.id === voiceId);
      const customAudioUrl = customVoice?.refAudioDataUrl || customVoice?.audioSampleUrl;
      
      let audio: HTMLAudioElement;
      if (customAudioUrl) {
        // Play custom voice sample directly from stored audio
        audio = new Audio(customAudioUrl);
        await audio.play();
      } else {
        // System voice - fetch sample from backend
        audio = await api.playVoiceSample(voiceId, language === 'zh' ? 'zh' : 'en');
      }
      
      audioRef.current = audio;
      setPlayingVoiceId(voiceId);
      setLoadingVoiceId(null);
      
      // When audio ends, clear playing state
      audio.onended = () => {
        setPlayingVoiceId(null);
        audioRef.current = null;
      };
      
      audio.onerror = () => {
        setPlayingVoiceId(null);
        setLoadingVoiceId(null);
        audioRef.current = null;
      };
    } catch (error) {
      console.error('Failed to play voice sample:', error);
      setLoadingVoiceId(null);
      setPlayingVoiceId(null);
    }
  };

  // Stop voice preview when leaving step 5
  useEffect(() => {
    if (currentStep !== 5 && audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
      setPlayingVoiceId(null);
    }
    // Stop media preview when leaving media production step
    if (currentStep !== 6 && mediaAudioRef.current) {
      mediaAudioRef.current.pause();
      mediaAudioRef.current = null;
      setPlayingMediaId(null);
    }
  }, [currentStep]);

  // Auto-advance from step 6 (media) to step 7 (mixing) when media production completes
  // Only advance if user has confirmed their media selections
  useEffect(() => {
    if (currentStep === 6 && mediaSelectionsConfirmed && production.mediaProduction.status === 'completed') {
      const timer = setTimeout(() => {
        setCurrentStep(7);
        setTimeout(() => performMixingRef.current(), 100);
      }, 600);
      return () => clearTimeout(timer);
    }
  }, [currentStep, mediaSelectionsConfirmed, production.mediaProduction.status]);

  // Auto-advance from step 7 (mixing) to step 8 (save) when mixing completes successfully
  useEffect(() => {
    if (currentStep === 7 && production.mixingEditing.status === 'completed' && production.mixingEditing.output && !production.mixingEditing.error) {
      const timer = setTimeout(() => {
        setCurrentStep(8);
      }, 600);
      return () => clearTimeout(timer);
    }
  }, [currentStep, production.mixingEditing.status, production.mixingEditing.output, production.mixingEditing.error]);

  // Initialize BGM selection when entering Step 6
  useEffect(() => {
    if (currentStep === 6 && !bgmSelection && specData.addBgm) {
      // Auto-select AI-recommended or default preset BGM
      const preset = bgmRecommendation
        ? (PRESET_BGM_LIST.find(p => p.id === bgmRecommendation.presetId) || PRESET_BGM_LIST[0])
        : PRESET_BGM_LIST[0];
      
      setBgmSelection({
        source: 'preset',
        prompt: specData.toneAndExpression || '',
        audioUrl: preset.url,
        presetId: preset.id,
      });
    }
  }, [currentStep, bgmSelection, bgmRecommendation, specData.addBgm, specData.toneAndExpression]);

  // Memoized action dispatchers to avoid re-creating on each render
  const updateTimelineItem = useCallback(
    (sectionId: string, itemId: string, field: 'timeStart' | 'timeEnd' | 'soundMusic', value: string) => {
      dispatch(actions.updateTimelineItem(sectionId, itemId, field, value));
    },
    []
  );

  const updateScriptLine = useCallback(
    (sectionId: string, itemId: string, lineIndex: number, field: 'speaker' | 'line', value: string) => {
      dispatch(actions.updateScriptLine(sectionId, itemId, lineIndex, field, value));
    },
    []
  );

  const addScriptLine = useCallback(
    (sectionId: string, itemId: string) => {
      // Count current total lines
      const currentTotal = stateRef.current.scriptSections.reduce((total, section) => {
        return total + section.timeline.reduce((sectionTotal, item) => {
          return sectionTotal + (item.lines?.length || 0);
        }, 0);
      }, 0);
      if (currentTotal >= MAX_SCRIPT_LINES) {
        return; // Limit reached, don't add
      }
      dispatch(actions.addScriptLine(sectionId, itemId));
    },
    []
  );

  const removeScriptLine = useCallback(
    (sectionId: string, itemId: string, lineIndex: number) => {
      dispatch(actions.removeScriptLine(sectionId, itemId, lineIndex));
    },
    []
  );

  // Split a script line at cursor position
  const splitScriptLine = useCallback(
    (sectionId: string, itemId: string, lineIndex: number, cursorPos: number) => {
      dispatch(actions.splitScriptLine(sectionId, itemId, lineIndex, cursorPos));
    },
    []
  );

  const addTimelineItem = useCallback(
    (sectionId: string) => {
      dispatch(actions.addTimelineItem(sectionId));
    },
    []
  );

  const removeTimelineItem = useCallback(
    (sectionId: string, itemId: string) => {
      dispatch(actions.removeTimelineItem(sectionId, itemId));
    },
    []
  );

  const updateSectionCover = useCallback(
    (sectionId: string, coverImageDescription: string) => {
      dispatch(actions.updateSectionCover(sectionId, coverImageDescription));
    },
    []
  );

  // Spec field update helper
  const updateSpecField = useCallback(
    <K extends keyof SpecData>(field: K, value: SpecData[K]) => {
      dispatch(actions.updateSpecField(field, value));
    },
    []
  );

  // Adapter: wrap reducer dispatch calls as ScriptEditorActions for shared components
  const scriptEditorActions: ScriptEditorActions = useMemo(() => ({
    updateSectionInfo: (sectionId, field, value) => {
      if (field === 'coverImageDescription') updateSectionCover(sectionId, value);
      // name/description are not editable in ProjectCreator's script step
    },
    updateTimelineItem,
    updateScriptLine,
    setLinePause: (sectionId, itemId, lineIndex, pauseAfterMs) => {
      dispatch(actions.setLinePause(sectionId, itemId, lineIndex, pauseAfterMs));
    },
    addScriptLine,
    removeScriptLine,
    splitScriptLine,
    addTimelineItem,
    removeTimelineItem,
  }), [updateSectionCover, updateTimelineItem, updateScriptLine, addScriptLine, removeScriptLine, splitScriptLine, addTimelineItem, removeTimelineItem]);

  // ============================================================
  // Shared orchestration hooks (voice, media, mixing)
  // ============================================================
  const availableVoicesRef = useRef(availableVoices);
  availableVoicesRef.current = availableVoices;
  const systemVoicesRef = useRef(systemVoices);
  systemVoicesRef.current = systemVoices;
  const bgmSelectionRef = useRef(bgmSelection);
  bgmSelectionRef.current = bgmSelection;

  const { generateVoiceForSection, performVoiceGeneration, regenerateVoiceForLine } = useVoiceGeneration({
    getScriptSections: () => stateRef.current.scriptSections,
    getCharacters: () => stateRef.current.characters,
    getAvailableVoices: () => availableVoicesRef.current,
    getSystemVoices: () => systemVoicesRef.current,
    language,
    updateSectionVoiceStatus: (sectionId, status, progress, error) => dispatch(actions.updateSectionVoiceStatus(sectionId, status, progress, error)),
    setCurrentSection: (sectionId) => dispatch(actions.setCurrentSection(sectionId)),
    addSectionVoiceAudio: (sectionId, audio) => dispatch(actions.addSectionVoiceAudio(sectionId, audio)),
    replaceSectionVoiceAudio: (sectionId, audioIndex, audio) => dispatch(actions.replaceSectionVoiceAudio(sectionId, audioIndex, audio)),
    updateProductionPhase: (_phase, status, progress, detail) => dispatch(actions.updateProductionPhase('voice-generation', status, progress, detail)),
    setRegeneratingLineId,
    setListenedSegments,
  });

  const { performMediaProduction, handleRegenMedia } = useMediaProduction({
    getScriptSections: () => stateRef.current.scriptSections,
    getSpec: () => stateRef.current.spec,
    getBgmSelection: () => bgmSelectionRef.current,
    getSfxSelections: () => ({}),
    getProduction: () => stateRef.current.production,
    language,
    title: stateRef.current.spec.storyTitle,
    setBgmAudio: (audio) => dispatch(actions.setBgmAudio(audio)),
    addSfxAudio: (sfx) => dispatch(actions.addSfxAudio(sfx)),
    updateSfxAudio: (index, sfx) => dispatch(actions.updateSfxAudio(index, sfx)),
    updateProductionPhase: (_phase, status, progress, detail) => dispatch(actions.updateProductionPhase('media-production', status, progress, detail)),
    setMediaSelectionsConfirmed,
    setRegeneratingId,
  });

  const { performMixing } = useMixingPipeline({
    getScriptSections: () => stateRef.current.scriptSections,
    getProduction: () => stateRef.current.production,
    getSpec: () => stateRef.current.spec,
    templateId: stateRef.current.selectedTemplateId,
    language,
    updateProductionPhase: (_phase, status, progress, detail) => dispatch(actions.updateProductionPhase('mixing-editing', status, progress, detail)),
    setMixedOutput: (output) => dispatch(actions.setMixedOutput(output)),
    setMixingError: (error) => dispatch(actions.setMixingError(error)),
  });

  performMixingRef.current = performMixing;

  // Handle create project
  const handleCreate = () => {
    const tags = specData.toneAndExpression.split(',').map(t => t.trim()).filter(t => t.length > 0);
    
    // Convert extracted characters to EpisodeCharacter format
    const episodeCharacters: EpisodeCharacter[] = extractedCharacters.map(char => ({
      name: char.name,
      description: char.description,
      assignedVoiceId: char.assignedVoiceId,
    }));
    
    const project = createProject({
      title: specData.storyTitle,
      subtitle: specData.subtitle,
      description: `${specData.targetAudience} | ${specData.formatAndDuration}`,
      religion,
      tags,
      // Save spec for creating future episodes
      spec: {
        targetAudience: specData.targetAudience,
        formatAndDuration: specData.formatAndDuration,
        toneAndExpression: specData.toneAndExpression,
        addBgm: specData.addBgm,
        addSoundEffects: specData.addSoundEffects,
        hasVisualContent: specData.hasVisualContent,
      },
      // First episode with generated script (if any)
      firstEpisode: scriptSections.length > 0 ? {
        title: `${t.projectCreator.episode1}: ${specData.storyTitle}`,
        subtitle: specData.subtitle,
        description: specData.toneAndExpression,
        scriptSections,
        characters: episodeCharacters,
        audioData: production.mixingEditing.output?.audioData,
        audioMimeType: production.mixingEditing.output?.mimeType,
        audioDurationMs: production.mixingEditing.output?.durationMs,
      } : undefined,
    });
    
    // Link generated media to the newly created project
    // Find recently generated media items (created in this session) and link them to the project
    const mediaItems = loadMediaItems();
    const recentMediaItems = mediaItems.filter(item => {
      // Check if this is a recently generated item (within last hour) without project association
      const createdAt = new Date(item.createdAt).getTime();
      const oneHourAgo = Date.now() - 60 * 60 * 1000;
      return item.source === 'generated' && 
             createdAt > oneHourAgo && 
             (!item.projectIds || item.projectIds.length === 0);
    });
    
    if (recentMediaItems.length > 0) {
      // Update media items to link to this project
      const updatedMediaItems = mediaItems.map(item => {
        if (recentMediaItems.some(r => r.id === item.id)) {
          return {
            ...item,
            projectIds: [project.id],
            updatedAt: new Date().toISOString()
          };
        }
        return item;
      });
      // Save updated media items to cloud
      saveMediaItems(updatedMediaItems);
      console.log(`Linked ${recentMediaItems.length} media items to project ${project.id}`);
    }
    
    // Clear draft on successful save
    clearDraft();
    onSuccess(project.id);
  };
  
  // Handle skip - save project with current progress and go to detail
  const handleSkipAndSave = () => {
    handleCreate();
  };

  // Handle discard draft - reset everything to initial state
  const handleDiscardDraft = () => {
    clearDraft();
    dispatch(actions.resetAll());
    setCurrentStep(1);
    setCustomDescription('');
    setTemplateConfig({ voiceCount: 'single', addBgm: false, addSoundEffects: false, hasVisualContent: false });
    setVoicesConfirmed(false);
    setDraftBanner(null);
  };

  // Navigation validation for 8-step workflow
  const canProceed = () => {
    switch (currentStep) {
      case 1: return selectedTemplateId !== null || customDescription.trim().length > 0; // Template selected OR custom description
      case 2: return specData.storyTitle.trim().length > 0 && !isExtractingCreativeContext; // Title filled and extraction done
      case 3: return contentInput.textContent.trim().length > 0 || contentInput.uploadedFiles.length > 0 || !!creativeContextRef.current; // Content provided or creative context available
      case 4: return scriptSections.length > 0; // Script generated
      case 5: return voicesConfirmed && production.voiceGeneration.status === 'completed'; // Voice confirmed and generation done
      case 6: return production.mediaProduction.status === 'completed'; // Media production done
      case 7: return production.mixingEditing.status === 'completed'; // Mixing done
      default: return true;
    }
  };

  const handleNext = async () => {
    // Step 1 -> 2: Template selected OR custom description, go to spec
    if (currentStep === 1) {
      // Check if the user already has customized spec data (returning from step 2).
      // If so, preserve it instead of overwriting with template/default values.
      const specAlreadyCustomized = specData.storyTitle.trim().length > 0
        || specData.targetAudience !== ''
        || specData.formatAndDuration !== '';

      if (selectedTemplateId && selectedTemplate) {
        if (!specAlreadyCustomized) {
          // Template mode - apply template defaults + user config to spec (first time only)
          dispatch(actions.setSpec({
            storyTitle: '',
            subtitle: '',
            targetAudience: selectedTemplate.defaultSpec.targetAudience,
            formatAndDuration: selectedTemplate.defaultSpec.formatAndDuration,
            toneAndExpression: selectedTemplate.defaultSpec.toneAndExpression,
            addBgm: templateConfig.addBgm,
            addSoundEffects: templateConfig.addSoundEffects,
            hasVisualContent: templateConfig.hasVisualContent,
          }));
        }
        setCurrentStep(2);
      } else if (customDescription.trim()) {
        if (!specAlreadyCustomized) {
          // Custom mode - set default spec values (first time only)
          dispatch(actions.setSpec({
            storyTitle: '',
            subtitle: '',
            targetAudience: '',
            formatAndDuration: '',
            toneAndExpression: '',
            addBgm: true,
            addSoundEffects: false,
            hasVisualContent: false,
          }));
        }
        // Store custom description in content input for later use
        if (!contentInput.textContent.trim()) {
          dispatch(actions.setTextContent(customDescription));
        }
        setCurrentStep(2);
      }
      return;
    }
    
    // Step 2 -> 3: Spec confirmed, go to content input
    if (currentStep === 2) {
      setCurrentStep(3);
      return;
    }
    
    // Step 3 -> 4: Content provided, go to script generation
    if (currentStep === 3) {
      setCurrentStep(4);
      // Only auto-trigger script generation if no script exists yet.
      // If the user is returning from step 4 (going back to 3 and forward again),
      // preserve the existing script and let them regenerate manually if needed.
      if (scriptSections.length === 0) {
        setTimeout(() => {
          generateScript();
        }, 100);
      }
      return;
    }
    
    // Step 4 -> 5: Script generated, extract characters and go to voice generation
    if (currentStep === 4 && scriptSections.length > 0) {
      setIsProcessingNext(true);
      // Re-extract characters from script (preserves existing voice assignments via reducer)
      extractCharacters();
      await new Promise(resolve => setTimeout(resolve, 300));
      setIsProcessingNext(false);
      setCurrentStep(5);
      // Only reset voice confirmation if voices haven't been generated yet.
      // If the user already completed voice generation and is returning here
      // (e.g. to tweak the script), preserve the confirmed state.
      if (production.voiceGeneration.status !== 'completed') {
        setVoicesConfirmed(false);
      }
      // DO NOT auto-start voice generation - wait for user to confirm voice assignments
      return;
    }
    
    // Step 5 -> 6: Voice generation done, go to media production (or skip if no media)
    if (currentStep === 5 && production.voiceGeneration.status === 'completed') {
      // Check if all segments have been listened to
      const allSectionStatus = production.voiceGeneration.sectionStatus;
      const totalSegs = scriptSections.reduce((acc, s) => {
        const st = allSectionStatus[s.id];
        return acc + (st?.status === 'completed' ? st.audioSegments.length : 0);
      }, 0);
      const listenedCount = scriptSections.reduce((acc, s) => {
        const st = allSectionStatus[s.id];
        if (st?.status !== 'completed') return acc;
        return acc + st.audioSegments.filter((_, i) => listenedSegments.has(`${s.id}-${i}`)).length;
      }, 0);
      
      if (totalSegs > 0 && listenedCount < totalSegs) {
        // Not all listened — show warning
        setShowListenWarning(true);
        return;
      }

      const hasMedia = specData.addBgm || specData.addSoundEffects || specData.hasVisualContent;
      if (!hasMedia) {
        // No media tasks — mark media production as completed and skip to mixing
        dispatch(actions.updateProductionPhase('media-production', 'completed', 100));
        setCurrentStep(7);
        setTimeout(() => {
          performMixing();
        }, 100);
      } else {
        // Go to Step 6 (media selection) - don't auto-start production
        // User needs to confirm their media selections first
        setCurrentStep(6);
      }
      return;
    }
    
    // Step 6 -> 7: Media production done, go to mixing
    if (currentStep === 6 && production.mediaProduction.status === 'completed') {
      setCurrentStep(7);
      // Auto-start mixing
      setTimeout(() => {
        performMixing();
      }, 100);
      return;
    }
    
    // Step 7 -> 8: Mixing done, go to save
    if (currentStep === 7 && production.mixingEditing.status === 'completed') {
      setCurrentStep(8);
      return;
    }
    
    if (currentStep < STEPS.length) setCurrentStep(currentStep + 1);
  };
  
  const handleBack = () => {
    if (currentStep === 5 && voicesConfirmed) {
      setVoicesConfirmed(false);
      return;
    }
    if (currentStep > 1) setCurrentStep(currentStep - 1);
  };

  // Calculate estimated time remaining
  const getEstimatedTime = () => {
    const totalSteps = STEPS.length;
    const avgTimePerStep = 1; // minutes per step
    const remainingSteps = totalSteps - currentStep;
    const estimatedMinutes = remainingSteps * avgTimePerStep;
    
    // During production phases, adjust based on progress
    if (currentStep >= 5 && currentStep <= 7) {
      const currentPhaseProgress = 
        currentStep === 5 ? production.voiceGeneration.progress :
        currentStep === 6 ? production.mediaProduction.progress :
        production.mixingEditing.progress;
      const remainingPhaseTime = Math.ceil(((100 - currentPhaseProgress) / 100) * 2);
      return remainingPhaseTime + (totalSteps - currentStep - 1) * avgTimePerStep;
    }
    
    return estimatedMinutes;
  };

  const getProgressPercentage = () => {
    // For production phases, include phase progress
    if (currentStep >= 5 && currentStep <= 7) {
      const baseProgress = ((currentStep - 1) / STEPS.length) * 100;
      const currentPhaseProgress = 
        currentStep === 5 ? production.voiceGeneration.progress :
        currentStep === 6 ? production.mediaProduction.progress :
        production.mixingEditing.progress;
      return baseProgress + (currentPhaseProgress / STEPS.length);
    }
    return (currentStep / STEPS.length) * 100;
  };

  // Handle Enter key for quick analyze
  const handleTextareaKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (contentInput.textContent.trim() || contentInput.uploadedFiles.length > 0) {
        analyzeWithGemini();
      }
    }
  };

  // Custom project description state
  const [customDescription, setCustomDescription] = useState('');

  // Template configuration state (shown after template selection)
  const [templateConfig, setTemplateConfig] = useState<{
    voiceCount: 'single' | 'multiple';
    addBgm: boolean;
    addSoundEffects: boolean;
    hasVisualContent: boolean;
  }>({
    voiceCount: 'single',
    addBgm: false,
    addSoundEffects: false,
    hasVisualContent: false,
  });

  // Handle custom description - clears template selection
  const handleCustomDescriptionChange = (value: string) => {
    setCustomDescription(value);
    if (value.trim() && selectedTemplateId) {
      dispatch(actions.clearTemplate());
    }
  };

  // Handle template selection - clears custom description and sets default config
  const handleTemplateSelect = (templateId: string) => {
    setCustomDescription('');
    
    const template = PROJECT_TEMPLATES.find(t => t.id === templateId);
    if (!template) return;
    
    handleSelectTemplate(templateId);
    // Set suggested defaults from template
    setTemplateConfig({
      voiceCount: template.suggestedDefaults.voiceCount,
      addBgm: template.suggestedDefaults.addBgm,
      addSoundEffects: template.suggestedDefaults.addSoundEffects,
      hasVisualContent: template.suggestedDefaults.hasVisualContent,
    });
  };

  // Render Step 1: Template Selection (NEW)
  const renderTemplateStep = () => {
    return (
    <div className="space-y-4 sm:space-y-6">
      {/* Template Grid - All Templates */}
      <div className="grid gap-2 sm:gap-3 grid-cols-2 sm:grid-cols-4">
        {PROJECT_TEMPLATES.map((template) => {
          const IconComponent = TemplateIconMap[template.icon] || FileText;
          const isSelected = selectedTemplateId === template.id;
          const { addBgm, addSoundEffects, hasVisualContent, voiceCount } = template.suggestedDefaults;
          
          return (
            <button
              key={template.id}
              onClick={() => handleTemplateSelect(template.id)}
              className={`relative p-3 rounded-xl border text-left transition-all ${
                isSelected 
                  ? 'border-t-border bg-t-card-hover' 
                  : 'border-t-border hover:border-t-border hover:bg-t-card'
              }`}
              style={isSelected ? { borderColor: theme.primary, background: `${theme.primary}15` } : {}}
            >
              {/* Header with icon and name */}
              <div className="flex items-center gap-2 mb-2">
                <div 
                  className="w-7 h-7 rounded-md flex items-center justify-center flex-shrink-0"
                  style={{ background: isSelected ? `${theme.primary}30` : 'var(--t-bg-card-hover)' }}
                >
                  <IconComponent size={14} className={isSelected ? '' : 'text-t-text2'} style={isSelected ? { color: theme.primaryLight } : {}} />
                </div>
                <p className="text-sm text-t-text1 font-medium flex-1">
                  {language === 'zh' ? template.nameZh : template.name}
                </p>
              </div>
              {/* Description */}
              <p className="text-[11px] text-t-text3 leading-relaxed">
                {language === 'zh' ? template.descriptionZh : template.description}
              </p>
              {/* Media option tags */}
              <div className="flex gap-1 mt-2">
                {voiceCount === 'multiple' && (
                  <div className="p-1 rounded bg-t-card-hover" title={language === 'zh' ? '多人' : 'Multi-voice'}>
                    <Users size={10} className="text-t-text3" />
                  </div>
                )}
                {addBgm && (
                  <div className="p-1 rounded bg-t-card-hover" title="BGM">
                    <Music size={10} className="text-t-text3" />
                  </div>
                )}
                {addSoundEffects && (
                  <div className="p-1 rounded bg-t-card-hover" title="SFX">
                    <Volume2 size={10} className="text-t-text3" />
                  </div>
                )}
                {hasVisualContent && (
                  <div className="p-1 rounded bg-t-card-hover" title={language === 'zh' ? '图片' : 'Images'}>
                    <Image size={10} className="text-t-text3" />
                  </div>
                )}
              </div>
              {isSelected && (
                <div 
                  className="absolute -top-1.5 -left-1.5 w-5 h-5 rounded-full flex items-center justify-center"
                  style={{ background: theme.primary }}
                >
                  <Check size={12} className="text-t-text1" />
                </div>
              )}
            </button>
          );
        })}
      </div>

      {/* Optional: Custom Description - always visible */}
      <div>
        <label className="block text-xs text-t-text3 mb-2">
          {language === 'zh' ? '项目描述（可选）' : 'Project description (optional)'}
        </label>
        <textarea
          value={customDescription}
          onChange={(e) => handleCustomDescriptionChange(e.target.value)}
          placeholder={language === 'zh' 
            ? '描述您想要创建的音频内容，AI 将根据描述辅助配置...' 
            : 'Describe the audio content you want to create, AI will use this to assist...'}
          rows={2}
          className="w-full px-4 py-3 rounded-xl border border-t-border bg-t-card text-base text-t-text1 placeholder-t-text3 focus:outline-none focus:border-t-border resize-none transition-all"
        />
      </div>
    </div>
  );
  };

  // Render Step 2: Spec Confirmation (simplified - no file upload)
  const renderSpecStep = () => {
    const isStoryTitleEmpty = specData.storyTitle.trim().length === 0;
    const optionalFilledCount = [
      specData.subtitle,
      specData.targetAudience,
      specData.formatAndDuration,
      specData.toneAndExpression,
    ].filter((value) => value.trim().length > 0).length;

    return (
      <div className="space-y-4 sm:space-y-6">
        {/* Loading indicator when extracting from creative context */}
        {isExtractingCreativeContext && (
          <div className="flex items-center gap-3 px-5 py-4 rounded-xl border border-t-border animate-pulse" style={{ background: 'var(--t-bg-card)' }}>
            <Loader2 size={18} className="animate-spin" style={{ color: theme.primaryLight }} />
            <span className="text-sm text-t-text2">
              {language === 'zh' ? '正在从创意对话中提取项目信息…' : 'Extracting project info from creative conversation…'}
            </span>
          </div>
        )}
        {/* Spec Form */}
        <div className="rounded-xl border border-t-border overflow-hidden" style={{ background: 'var(--t-bg-card)' }}>
          <div className="px-5 py-4 border-b border-t-border flex items-center justify-between">
            <h4 className="text-base font-medium text-t-text1">
              {language === 'zh' ? '项目规格' : 'Project Specification'}
            </h4>
            {/* Compact Template Badge */}
            <div className="flex items-center gap-2">
              {selectedTemplate ? (
                <>
                  <div 
                    className="flex items-center gap-2 px-3 py-1.5 rounded-lg"
                    style={{ background: `${theme.primary}15` }}
                  >
                    <div 
                      className="w-5 h-5 rounded flex items-center justify-center"
                      style={{ background: `${theme.primary}30` }}
                    >
                      {(() => {
                        const IconComponent = TemplateIconMap[selectedTemplate.icon] || FileText;
                        return <IconComponent size={12} style={{ color: theme.primaryLight }} />;
                      })()}
                    </div>
                    <span className="text-sm text-t-text2">
                      {language === 'zh' ? selectedTemplate.nameZh : selectedTemplate.name}
                    </span>
                  </div>
                  <button
                    onClick={() => setCurrentStep(1)}
                    className="text-xs text-t-text3 hover:text-t-text2 px-2 py-1 rounded hover:bg-t-card-hover transition-all"
                  >
                    {language === 'zh' ? '更换模板' : 'Change template'}
                  </button>
                </>
              ) : (
                <>
                  <div 
                    className="flex items-center gap-2 px-3 py-1.5 rounded-lg"
                    style={{ background: `${theme.primary}15` }}
                  >
                    <Sparkles size={12} style={{ color: theme.primaryLight }} />
                    <span className="text-sm text-t-text2">
                      {language === 'zh' ? '自定义' : 'Custom'}
                    </span>
                  </div>
                  <button
                    onClick={() => setCurrentStep(1)}
                    className="text-xs text-t-text3 hover:text-t-text2 px-2 py-1 rounded hover:bg-t-card-hover transition-all"
                  >
                    {language === 'zh' ? '更换模板' : 'Change template'}
                  </button>
                </>
              )}
            </div>
          </div>
          <div className="p-5 space-y-5">
            {/* Required: Story Title */}
            <div>
              <label className="flex items-center gap-2 text-sm text-t-text3 mb-2">
                <span>{language === 'zh' ? '项目标题' : 'Project title'}</span>
                <span className="text-xs font-medium" style={{ color: theme.primaryLight }}>
                  * {language === 'zh' ? '必填' : 'Required'}
                </span>
              </label>
              <input
                type="text"
                value={specData.storyTitle}
                onChange={(e) => updateSpecField('storyTitle', e.target.value)}
                placeholder={language === 'zh' ? '为您的项目起一个标题，例如书名或系列名称。' : 'Give your project a title. For example a book name or series title.'}
                className="w-full px-4 py-3 rounded-lg border border-t-border bg-t-card text-base text-t-text1 focus:outline-none"
                style={isStoryTitleEmpty ? { borderColor: theme.primaryLight, boxShadow: `0 0 0 1px ${theme.primaryLight}40` } : {}}
              />
            </div>

            {/* Always visible: Voice Count & Media Options */}
            <div className="flex flex-wrap items-start gap-6">
              {/* Voice Count Toggle */}
              <div>
                <label className="block text-sm text-t-text3 mb-2">
                  {language === 'zh' ? '声音' : 'Voice'}
                </label>
                <div className="flex gap-2">
                  <button
                    onClick={() => setTemplateConfig(prev => ({ ...prev, voiceCount: 'single' }))}
                    className={`px-3 py-2 rounded-lg text-sm font-medium transition-all ${
                      templateConfig.voiceCount === 'single'
                        ? 'text-t-text1'
                        : 'text-t-text3 border border-t-border hover:border-t-border'
                    }`}
                    style={templateConfig.voiceCount === 'single' ? { background: theme.primary } : {}}
                  >
                    <User size={14} className="inline mr-1.5" />
                    {language === 'zh' ? '单人' : 'Single'}
                  </button>
                  <button
                    onClick={() => setTemplateConfig(prev => ({ ...prev, voiceCount: 'multiple' }))}
                    className={`px-3 py-2 rounded-lg text-sm font-medium transition-all ${
                      templateConfig.voiceCount === 'multiple'
                        ? 'text-t-text1'
                        : 'text-t-text3 border border-t-border hover:border-t-border'
                    }`}
                    style={templateConfig.voiceCount === 'multiple' ? { background: theme.primary } : {}}
                  >
                    <User size={14} className="inline mr-1" />
                    <User size={14} className="inline -ml-2 mr-1" />
                    {language === 'zh' ? '多人' : 'Multi'}
                  </button>
                </div>
              </div>

              {/* Media Options */}
              <div>
                <label className="block text-sm text-t-text3 mb-2">
                  {language === 'zh' ? '媒体' : 'Media'}
                </label>
                <div className="flex gap-2">
                  <button
                    onClick={() => updateSpecField('addBgm', !specData.addBgm)}
                    className={`px-3 py-2 rounded-lg text-sm font-medium transition-all flex items-center gap-1.5 ${
                      specData.addBgm
                        ? 'text-t-text1'
                        : 'text-t-text3 border border-t-border hover:border-t-border'
                    }`}
                    style={specData.addBgm ? { background: theme.primary } : {}}
                  >
                    <Music size={14} />
                    BGM
                  </button>
                  <button
                    onClick={() => updateSpecField('addSoundEffects', !specData.addSoundEffects)}
                    className={`px-3 py-2 rounded-lg text-sm font-medium transition-all flex items-center gap-1.5 ${
                      specData.addSoundEffects
                        ? 'text-t-text1'
                        : 'text-t-text3 border border-t-border hover:border-t-border'
                    }`}
                    style={specData.addSoundEffects ? { background: theme.primary } : {}}
                  >
                    <Volume2 size={14} />
                    SFX
                  </button>
                  <button
                    onClick={() => updateSpecField('hasVisualContent', !specData.hasVisualContent)}
                    className={`px-3 py-2 rounded-lg text-sm font-medium transition-all flex items-center gap-1.5 ${
                      specData.hasVisualContent
                        ? 'text-t-text1'
                        : 'text-t-text3 border border-t-border hover:border-t-border'
                    }`}
                    style={specData.hasVisualContent ? { background: theme.primary } : {}}
                  >
                    <Image size={14} />
                    {language === 'zh' ? '图片' : 'Images'}
                  </button>
                </div>
              </div>
            </div>

            {/* Optional fields are folded by default to reduce cognitive load */}
            <div className="rounded-lg border border-t-border overflow-hidden">
              <button
                type="button"
                onClick={() => setShowOptionalSpecFields(prev => !prev)}
                className="w-full px-4 py-3 flex items-center justify-between text-left hover:bg-t-card-hover transition-all"
              >
                <div className="flex items-center gap-2">
                  <span className="text-sm text-t-text2">
                    {language === 'zh' ? '可选项' : 'Optional details'}
                  </span>
                  {optionalFilledCount > 0 && (
                    <span className="text-xs px-2 py-0.5 rounded-full text-t-text2 bg-t-card-hover">
                      {language === 'zh' ? `已填写 ${optionalFilledCount}` : `${optionalFilledCount} filled`}
                    </span>
                  )}
                </div>
                {showOptionalSpecFields ? <ChevronDown size={16} className="text-t-text3" /> : <ChevronRight size={16} className="text-t-text3" />}
              </button>

              {showOptionalSpecFields && (
                <div className="p-4 border-t border-t-border space-y-5">
                  {/* Subtitle - Toggle Option */}
                  {showSubtitle ? (
                    <div>
                      <div className="flex items-center justify-between mb-2">
                        <label className="block text-sm text-t-text3">
                          {language === 'zh' ? '项目描述' : 'Project description'}
                        </label>
                        <button
                          onClick={() => {
                            setShowSubtitle(false);
                            updateSpecField('subtitle', '');
                          }}
                          className="text-sm text-t-text3 hover:text-t-text2 transition-all"
                        >
                          <X size={14} />
                        </button>
                      </div>
                      <input
                        type="text"
                        value={specData.subtitle}
                        onChange={(e) => updateSpecField('subtitle', e.target.value)}
                        placeholder={language === 'zh' ? '简要描述您的项目以及它的用途。' : 'Briefly describe your project and how it will be used.'}
                        className="w-full px-4 py-3 rounded-lg border border-t-border bg-t-card text-base text-t-text1 focus:outline-none focus:border-t-border"
                      />
                    </div>
                  ) : (
                    <button
                      onClick={() => setShowSubtitle(true)}
                      className="flex items-center gap-2 text-sm text-t-text3 hover:text-t-text2 transition-all"
                    >
                      <Plus size={14} />
                      {language === 'zh' ? '添加项目描述' : 'Add a short description'}
                    </button>
                  )}
                  {/* Target Audience */}
                  <div>
                    <label className="block text-sm text-t-text3 mb-2">
                      {language === 'zh' ? '这个音频是为谁制作的？' : 'Who is this audio for?'}
                    </label>
                    <input
                      type="text"
                      value={specData.targetAudience}
                      onChange={(e) => updateSpecField('targetAudience', e.target.value)}
                      placeholder={language === 'zh' ? '描述您的目标听众。例如年龄范围、收听原因或方式。' : 'Describe your intended listeners. For example, age range, why or how they will listen.'}
                      className="w-full px-4 py-3 rounded-lg border border-t-border bg-t-card text-base text-t-text1 focus:outline-none focus:border-t-border"
                    />
                  </div>
                  {/* Format and Duration */}
                  <div>
                    <label className="block text-sm text-t-text3 mb-2">
                      {language === 'zh' ? '结构和长度' : 'Structure and length'}
                    </label>
                    <input
                      type="text"
                      value={specData.formatAndDuration}
                      onChange={(e) => updateSpecField('formatAndDuration', e.target.value)}
                      placeholder={language === 'zh' ? '描述项目的结构。例如短小章节、长篇章节或单段连续内容。' : 'Describe how your project is structured. For example short sections, chapters, or a single continuous piece.'}
                      className="w-full px-4 py-3 rounded-lg border border-t-border bg-t-card text-base text-t-text1 focus:outline-none focus:border-t-border"
                    />
                  </div>
                  {/* Tone and Expression */}
                  <div>
                    <label className="block text-sm text-t-text3 mb-2">
                      {language === 'zh' ? '语气和表达风格' : 'Tone and delivery style'}
                    </label>
                    <input
                      type="text"
                      value={specData.toneAndExpression}
                      onChange={(e) => updateSpecField('toneAndExpression', e.target.value)}
                      placeholder={language === 'zh' ? '描述声音应给听众的感受。例如平静、温暖、教学性、对话式、严肃或富有表现力。' : 'Describe how the voice(s) should sound to the listener. For example calm, warm, instructional, conversational, serious, or expressive.'}
                      className="w-full px-4 py-3 rounded-lg border border-t-border bg-t-card text-base text-t-text1 focus:outline-none focus:border-t-border"
                    />
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  };

  // Render Step 3: Content Input (NEW - moved from old Step 1)
  const renderContentInputStep = () => (
    <div className="space-y-4 sm:space-y-6">
      {/* First Episode Banner */}
      <div 
        className="flex items-center gap-3 px-5 py-4 rounded-xl border border-t-border"
        style={{ background: `${theme.primary}10` }}
      >
        <div 
          className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0"
          style={{ background: `${theme.primary}25` }}
        >
          <Sparkles size={18} style={{ color: theme.primaryLight }} />
        </div>
        <div>
          <p className="text-sm font-medium text-t-text1">
            {t.projectCreator.firstEpisodeBanner}
          </p>
          <p className="text-xs text-t-text3 mt-0.5">
            {t.projectCreator.firstEpisodeHint}
          </p>
        </div>
      </div>

      {/* Text Input with File Attachment */}
      <div>
        <label className="block text-base font-medium text-t-text2 mb-3 flex items-center justify-end gap-2">
          <span className="text-t-text3 font-normal text-sm">
            {language === 'zh' ? '⌘+Enter 快速分析' : '⌘+Enter to analyze'}
          </span>
        </label>
        <div 
          className={`relative rounded-xl border transition-all ${
            isDragging 
              ? 'border-t-border bg-t-card-hover' 
              : 'border-t-border bg-t-card'
          }`}
          onDragEnter={handleDragEnter}
          onDragLeave={handleDragLeave}
          onDragOver={handleDragOver}
          onDrop={handleDrop}
        >
          <textarea
            value={contentInput.textContent}
            onChange={(e) => handleTextContentChange(e.target.value)}
            onKeyDown={handleTextareaKeyDown}
            placeholder={contentInput.uploadedFiles.length > 0
              ? (language === 'zh'
                ? '输入处理指令（可选）...\n\n例如：保留数字的朗读方式、用轻松的语气改写、只提取对话部分等'
                : 'Enter processing instructions (optional)...\n\nExample: Preserve number reading, rewrite in a casual tone, extract dialogue only, etc.')
              : (language === 'zh' 
                ? '粘贴或输入您的内容...\n\n例如：书籍章节、故事文本、播客脚本等' 
                : 'Paste or enter your content...\n\nExample: Book chapter, story text, podcast script, etc.')}
            rows={8}
            className="w-full px-5 pt-4 pb-3 bg-transparent text-base text-t-text1 placeholder-t-text3 focus:outline-none resize-none"
          />
          
          {/* Attachment Area */}
          <div className="px-5 pb-4 pt-2 border-t border-t-border-lt">
            <input
              ref={fileInputRef}
              type="file"
              onChange={handleFileUpload}
              accept=".txt,.pdf,.doc,.docx"
              multiple
              className="hidden"
            />
            
            {/* Uploaded Files List */}
            {contentInput.uploadedFiles.length > 0 && (
              <div className="mb-3 space-y-2">
                {contentInput.uploadedFiles.map((file, index) => (
                  <div 
                    key={index}
                    className="flex items-center gap-3 px-3 py-2 rounded-lg border border-t-border"
                    style={{ background: `${theme.primary}10` }}
                  >
                    <FileText size={16} style={{ color: theme.primaryLight }} />
                    <span className="flex-1 text-sm text-t-text1 truncate">{file.name}</span>
                    <span className="text-xs text-t-text3">{(file.size / 1024).toFixed(1)}KB</span>
                    <button
                      onClick={() => removeUploadedFile(index)}
                      className="p-1 rounded hover:bg-t-card-hover text-t-text3 hover:text-red-400 transition-all"
                    >
                      <X size={14} />
                    </button>
                  </div>
                ))}
              </div>
            )}
            
            {/* Add Attachment Button */}
            <button
              onClick={() => fileInputRef.current?.click()}
              className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm text-t-text3 hover:text-t-text2 hover:bg-t-card transition-all"
            >
              <Upload size={16} />
              <span>
                {isDragging 
                  ? (language === 'zh' ? '放开以上传' : 'Drop to upload')
                  : (language === 'zh' ? '点击上传 TXT、PDF 或 Word 文件' : 'Click to upload TXT, PDF or Word file')}
              </span>
            </button>
          </div>
          
          {/* Drag Overlay */}
          {isDragging && (
            <div className="absolute inset-0 flex items-center justify-center rounded-xl bg-t-card backdrop-blur-sm pointer-events-none">
              <div className="flex flex-col items-center gap-2 text-t-text2">
                <Upload size={36} />
                <span className="text-base font-medium">
                  {language === 'zh' ? '放开以上传' : 'Drop to upload'}
                </span>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Optional: Auto-analyze button to extract title */}
      {(contentInput.textContent.trim() || contentInput.uploadedFiles.length > 0) && !specData.storyTitle && (
        <button
          onClick={analyzeWithGemini}
          disabled={isAnalyzing}
          className={`w-full flex items-center justify-center gap-2 px-5 py-4 rounded-xl text-base text-t-text2 border border-t-border font-medium transition-all hover:bg-t-card ${
            isAnalyzing ? 'animate-pulse' : ''
          }`}
        >
          {isAnalyzing ? (
            <>
              <Loader2 size={20} className="animate-spin" />
              {language === 'zh' ? '分析中...' : 'Analyzing...'}
            </>
          ) : (
            <>
              <Wand2 size={20} />
              {language === 'zh' ? '自动提取标题' : 'Auto-extract Title'}
            </>
          )}
        </button>
      )}
    </div>
  );

  // Render Step 4: Script Generation - uses shared ScriptEditorStep
  const renderScriptStep = () => (
    <ScriptEditorStep
      scriptSections={scriptSections}
      editingSection={editingSection}
      onEditingSectionChange={setEditingSection}
      isGeneratingScript={isGeneratingScript}
      streamingText={streamingText}
      onGenerateScript={generateScript}
      actions={scriptEditorActions}
      knownSpeakers={knownSpeakers}
      totalLineCount={totalLineCount}
      maxScriptLines={MAX_SCRIPT_LINES}
      hasVisualContent={specData.hasVisualContent}
      hasAudio={specData.addBgm || specData.addSoundEffects}
      streamingParsed={streamingParsed}
      t={t}
    />
  );

  // Render Step 5: Voice Generation (NEW)
  const renderVoiceGenerationStep = () => {
    const { voiceGeneration } = production;
    
    // Show voice assignment UI before confirming
    if (!voicesConfirmed) {
      return (
        <div className="space-y-4 sm:space-y-6">
          <div className="text-center py-2 sm:py-4">
            <div 
              className="w-10 h-10 sm:w-16 sm:h-16 mx-auto mb-2 sm:mb-4 rounded-full flex items-center justify-center"
              style={{ background: `${theme.primary}20` }}
            >
              <Mic2 size={20} className="sm:hidden" style={{ color: theme.primaryLight }} />
              <Mic2 size={32} className="hidden sm:block" style={{ color: theme.primaryLight }} />
            </div>
            <h3 className="text-base sm:text-xl font-medium text-t-text1 mb-1 sm:mb-2">
              {language === 'zh' ? '角色音色配置' : 'Character Voice Configuration'}
            </h3>
            <p className="text-sm sm:text-base text-t-text3">
              {language === 'zh' 
                ? '为每个角色选择音色，确认后开始语音合成' 
                : 'Assign voices to each character, then start synthesis'}
            </p>
          </div>

          {/* Character voice assignment list */}
          {extractedCharacters.length > 0 && (
            <div className="rounded-xl border border-t-border overflow-hidden" style={{ background: 'var(--t-bg-card)' }}>
              <div className="px-5 py-3 border-b border-t-border flex items-center justify-between">
                <span className="text-sm text-t-text3">
                  {language === 'zh' ? '角色音色分配' : 'Character Voice Assignment'}
                </span>
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={generateVoicesForAll}
                    disabled={isRecommendingVoices || extractedCharacters.filter(c => c.voiceDescription && !c.assignedVoiceId).length === 0}
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
                    {extractedCharacters.length} {language === 'zh' ? '个角色' : 'characters'}
                  </span>
                </div>
              </div>
              <div className="p-4 space-y-3">
                {extractedCharacters.map((char, index) => {
                  const assignedVoiceId = char.assignedVoiceId;
                  const assignedSystemVoice = systemVoices.find(v => v.id === assignedVoiceId);
                  const assignedCustomVoice = availableVoices.find(v => v.id === assignedVoiceId);
                  const hasAssignment = assignedSystemVoice || assignedCustomVoice;
                  
                  return (
                    <div key={index} className="flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-4 p-3 sm:p-4 rounded-lg bg-t-card border border-t-border-lt">
                      <div className="flex items-center gap-3 sm:gap-4">
                        <div className="w-9 h-9 sm:w-12 sm:h-12 rounded-full flex items-center justify-center bg-t-card-hover flex-shrink-0">
                          <User size={16} className="sm:hidden text-t-text2" />
                          <User size={20} className="hidden sm:block text-t-text2" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="text-sm sm:text-base text-t-text1 font-medium truncate">{char.name}</p>
                          {char.description && (
                            <p className="text-xs sm:text-sm text-t-text3 truncate">{char.description}</p>
                          )}
                          {/* Character tags (gender, age, voice style, etc.) */}
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
                      </div>
                      <div className="flex items-center gap-2 pl-12 sm:pl-0">
                        <button
                          onClick={() => setVoicePickerCharIndex(index)}
                          className="px-3 sm:px-4 py-2 sm:py-2.5 rounded-lg border text-sm sm:text-base font-medium transition-all hover:scale-105 flex items-center gap-2 min-w-0 sm:min-w-[160px] flex-1 sm:flex-none"
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
                        {/* Play button for assigned voice */}
                        {assignedSystemVoice && (
                          <button 
                            onClick={() => playVoiceSample(assignedSystemVoice.id)}
                            disabled={loadingVoiceId === assignedSystemVoice.id}
                            className={`p-2.5 rounded-lg transition-all ${
                              playingVoiceId === assignedSystemVoice.id 
                                ? 'text-t-text1' 
                                : 'text-t-text3 hover:text-t-text1 hover:bg-t-card-hover'
                            }`}
                            style={playingVoiceId === assignedSystemVoice.id ? { background: theme.primary } : {}}
                            title={language === 'zh' ? '试听' : 'Preview'}
                          >
                            {loadingVoiceId === assignedSystemVoice.id ? (
                              <Loader2 size={18} className="animate-spin" />
                            ) : playingVoiceId === assignedSystemVoice.id ? (
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
          {extractedCharacters.length === 0 && (
            <div className="text-center py-6 sm:py-10 text-t-text3">
              <User size={28} className="sm:hidden mx-auto mb-2 opacity-50" />
              <User size={40} className="hidden sm:block mx-auto mb-3 opacity-50" />
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

          {/* Start synthesis button */}
          <button
            onClick={startVoiceGeneration}
            disabled={extractedCharacters.length === 0}
            className="w-full flex items-center justify-center gap-3 px-5 py-4 rounded-xl text-base text-t-text1 font-medium transition-all hover:scale-[1.02] disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:scale-100"
            style={{ background: theme.primary }}
          >
            <Mic2 size={22} />
            {language === 'zh' ? '确认并开始语音合成' : 'Confirm & Start Voice Synthesis'}
          </button>

          {/* Voice Picker Modal */}
          {voicePickerCharIndex !== null && extractedCharacters[voicePickerCharIndex] && (
            <VoicePickerModal
              character={extractedCharacters[voicePickerCharIndex]}
              systemVoices={systemVoices}
              customVoices={availableVoices}
              playingVoiceId={playingVoiceId}
              loadingVoiceId={loadingVoiceId}
              projectVoiceIds={extractedCharacters.map(c => c.assignedVoiceId).filter((id): id is string => !!id)}
              scriptSections={scriptSections}
              onAssign={(voiceId) => {
                assignVoiceToCharacter(voicePickerCharIndex, voiceId);
              }}
              onPlayVoice={playVoiceSample}
              onCreateVoice={async (name, description, file) => {
                const charIndex = voicePickerCharIndex;
                try {
                  // Read file as data URL
                  const dataUrl = await new Promise<string>((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onload = () => resolve(reader.result as string);
                    reader.onerror = reject;
                    reader.readAsDataURL(file);
                  });

                  // Create new voice character
                  const updatedVoices = addVoiceCharacter(availableVoices, {
                    name: name,
                    description: description || (language === 'zh' ? '自定义音色' : 'Custom voice'),
                    refAudioDataUrl: dataUrl,
                    audioSampleUrl: dataUrl,
                    tags: ['uploaded'],
                  });

                  const newVoice = updatedVoices[updatedVoices.length - 1];
                  setAvailableVoices(updatedVoices);
                  
                  // Auto-assign to character
                  assignVoiceToCharacter(charIndex, newVoice.id);
                } catch (error) {
                  console.error('Failed to create voice:', error);
                  alert(language === 'zh' ? '创建音色失败' : 'Failed to create voice');
                  throw error;
                }
              }}
              onClose={() => setVoicePickerCharIndex(null)}
            />
          )}
        </div>
      );
    }
    
    // Show section-by-section voice generation UI after confirming
    const { sectionStatus } = voiceGeneration;
    const completedSections = scriptSections.filter(s => sectionStatus[s.id]?.status === 'completed').length;
    const allCompleted = completedSections === scriptSections.length && scriptSections.length > 0;

    // Compute total listened stats
    const totalSegments = scriptSections.reduce((acc, s) => {
      const st = sectionStatus[s.id];
      return acc + (st?.status === 'completed' ? st.audioSegments.length : 0);
    }, 0);
    const totalListened = scriptSections.reduce((acc, s) => {
      const st = sectionStatus[s.id];
      if (st?.status !== 'completed') return acc;
      return acc + st.audioSegments.filter((_, i) => listenedSegments.has(`${s.id}-${i}`)).length;
    }, 0);
    const allListened = allCompleted && totalSegments > 0 && totalListened === totalSegments;
    
    return (
      <div className="space-y-4 sm:space-y-6">
        {/* Overall progress header — compact */}
        <div className="flex items-center gap-3 px-3 sm:px-4 py-2.5 sm:py-3 rounded-xl border border-t-border" style={{ background: `${theme.primary}10` }}>
          <div 
            className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0"
            style={{ background: `${theme.primary}25` }}
          >
            {allCompleted ? (
              <Check size={18} style={{ color: theme.primaryLight }} />
            ) : (
              <Mic2 size={18} className={voiceGeneration.status === 'processing' ? 'animate-pulse' : ''} style={{ color: theme.primaryLight }} />
            )}
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-t-text1">
              {language === 'zh' ? '逐段语音生成' : 'Voice Generation'}
            </p>
            <p className="text-xs text-t-text3">
              {allCompleted 
                ? (allListened
                    ? (language === 'zh' ? '所有段落已完成并已审听' : 'All sections completed and reviewed')
                    : `${totalListened}/${totalSegments} ${language === 'zh' ? '条已审听' : 'clips reviewed'}`)
                : `${completedSections}/${scriptSections.length} ${language === 'zh' ? '段落已完成' : 'sections completed'}`
              }
            </p>
          </div>
        </div>

        {/* Section list with individual controls */}
        <div className="space-y-4">
          {scriptSections.map((section, index) => {
            const status = sectionStatus[section.id] || { status: 'idle', progress: 0, audioSegments: [] };
            const isCurrentSection = voiceGeneration.currentSectionId === section.id;
            const lineCount = section.timeline.reduce((acc, item) => acc + (item.lines?.filter(l => l.line.trim()).length || 0), 0);
            const isCollapsed = collapsedVoiceSections.has(section.id);
            // Compute listened count for this section
            const sectionListenedCount = status.status === 'completed' 
              ? status.audioSegments.filter((_, i) => listenedSegments.has(`${section.id}-${i}`)).length 
              : 0;
            const sectionAllListened = status.status === 'completed' && status.audioSegments.length > 0 && sectionListenedCount === status.audioSegments.length;
            
            return (
              <div 
                key={section.id}
                className={`rounded-xl border overflow-hidden transition-all ${
                  isCurrentSection ? 'border-t-border' : 'border-t-border'
                }`}
                style={{ background: 'var(--t-bg-card)' }}
              >
                {/* Section header */}
                <div 
                  className={`px-5 py-4 flex items-center gap-4 ${
                    status.status === 'completed' && status.audioSegments.length > 0 
                      ? 'cursor-pointer hover:bg-t-card transition-colors' 
                      : ''
                  }`}
                  onClick={() => {
                    if (status.status === 'completed' && status.audioSegments.length > 0) {
                      setCollapsedVoiceSections(prev => {
                        const next = new Set(prev);
                        if (next.has(section.id)) {
                          next.delete(section.id);
                        } else {
                          next.add(section.id);
                          // Stop playing audio when collapsing
                          if (segmentAudioRef.current) {
                            segmentAudioRef.current.pause();
                            segmentAudioRef.current = null;
                          }
                          setPlayingSegmentId(null);
                        }
                        return next;
                      });
                    }
                  }}
                >
                  {/* Status icon — shows review status for completed */}
                  <div 
                    className="w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0"
                    style={{ 
                      background: status.status === 'completed' 
                        ? (sectionAllListened ? 'rgba(34, 197, 94, 0.25)' : `${theme.primary}30`)
                        : status.status === 'processing' 
                          ? `${theme.primary}20` 
                          : status.status === 'error'
                            ? 'rgba(239, 68, 68, 0.2)'
                            : 'var(--t-bg-card)'
                    }}
                  >
                    {status.status === 'completed' ? (
                      sectionAllListened ? (
                        <Check size={20} className="text-green-400" />
                      ) : (
                        <Headphones size={20} style={{ color: theme.primaryLight }} />
                      )
                    ) : status.status === 'processing' ? (
                      <Loader2 size={20} className="animate-spin" style={{ color: theme.primaryLight }} />
                    ) : status.status === 'error' ? (
                      <X size={20} className="text-red-400" />
                    ) : (
                      <span className="text-t-text3 text-sm font-medium">{index + 1}</span>
                    )}
                  </div>
                  
                  {/* Section info */}
                  <div className="flex-1 min-w-0">
                    <h4 className="text-base font-medium text-t-text1 truncate">{section.name}</h4>
                    <p className="text-sm text-t-text3">
                      {lineCount} {language === 'zh' ? '条对话' : 'lines'}
                      {status.status === 'completed' && status.audioSegments.length > 0 && (
                        <span className="ml-2" style={{ color: sectionAllListened ? 'rgb(74, 222, 128)' : theme.primaryLight }}>
                          · {sectionListenedCount}/{status.audioSegments.length} {language === 'zh' ? '已审听' : 'reviewed'}
                        </span>
                      )}
                    </p>
                  </div>
                  
                  {/* Action buttons */}
                  <div className="flex items-center gap-2" onClick={e => e.stopPropagation()}>
                    {/* Progress indicator for processing */}
                    {status.status === 'processing' && (
                      <span className="text-sm font-medium" style={{ color: theme.primaryLight }}>
                        {status.progress}%
                      </span>
                    )}
                    
                    {/* Generate / Retry button */}
                    {(status.status === 'idle' || status.status === 'error') && (
                      <button
                        onClick={async () => {
                          await generateVoiceForSection(section);
                          // After individual section generation, restore overall status if needed
                          dispatch(actions.updateProductionPhase('voice-generation', 'completed', 100));
                        }}
                        disabled={voiceGeneration.status === 'processing'}
                        className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all hover:scale-105 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:scale-100"
                        style={{ background: theme.primary }}
                      >
                        <Mic2 size={16} />
                        {status.status === 'error' 
                          ? (language === 'zh' ? '重试' : 'Retry')
                          : (language === 'zh' ? '生成' : 'Generate')
                        }
                      </button>
                    )}
                    
                    {/* Regenerate ALL button for completed sections */}
                    {status.status === 'completed' && (
                      <button
                        onClick={async () => {
                          dispatch(actions.clearSectionVoice(section.id));
                          // Clear listened state for this section
                          setListenedSegments(prev => {
                            const next = new Set(prev);
                            for (const key of prev) {
                              if (key.startsWith(`${section.id}-`)) next.delete(key);
                            }
                            return next;
                          });
                          await generateVoiceForSection(section);
                          // After individual section regen, restore overall status to 'completed'
                          // (all other sections are already completed since regen is only available for completed sections)
                          dispatch(actions.updateProductionPhase('voice-generation', 'completed', 100));
                        }}
                        disabled={voiceGeneration.status === 'processing'}
                        className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-t-text2 hover:text-t-text1 hover:bg-t-card-hover transition-all disabled:opacity-50"
                        title={language === 'zh' ? '全部重新生成' : 'Regenerate all'}
                      >
                        <RefreshCw size={16} />
                      </button>
                    )}
                    
                    {/* Collapse/expand chevron for completed sections */}
                    {status.status === 'completed' && status.audioSegments.length > 0 && (
                      <ChevronDown 
                        size={18} 
                        className={`text-t-text3 transition-transform duration-200 ${
                          !isCollapsed ? 'rotate-180' : ''
                        }`} 
                      />
                    )}
                  </div>
                </div>
                
                {/* Progress bar for processing sections */}
                {status.status === 'processing' && (
                  <div className="px-5 pb-4">
                    <div className="h-1.5 rounded-full bg-t-card-hover overflow-hidden">
                      <div 
                        className="h-full rounded-full transition-all duration-300"
                        style={{ width: `${status.progress}%`, background: theme.primary }}
                      />
                    </div>
                  </div>
                )}
                
                {/* Error message */}
                {status.status === 'error' && status.error && (
                  <div className="px-5 pb-4">
                    <p className="text-sm text-red-400">{status.error}</p>
                  </div>
                )}
                
                {/* Audio segment list — visible by default for completed sections (collapsible) */}
                {status.status === 'completed' && status.audioSegments.length > 0 && !isCollapsed && (
                  <div className="border-t border-t-border-lt">
                    <div className="divide-y divide-t-border-lt">
                      {status.audioSegments.map((audio, audioIndex) => {
                        const segId = `${section.id}-${audioIndex}`;
                        const isPlaying = playingSegmentId === segId;
                        const isListened = listenedSegments.has(segId);
                        const isRegenerating = regeneratingLineId === segId;
                        return (
                          <div 
                            key={audioIndex}
                            className={`px-5 py-3 flex items-center gap-3 hover:bg-t-card transition-colors ${
                              isListened ? 'bg-[var(--t-bg-card)]' : ''
                            }`}
                          >
                            {/* Play/Pause button */}
                            <button
                              onClick={() => {
                                if (isPlaying) {
                                  // Stop current
                                  if (segmentAudioRef.current) {
                                    segmentAudioRef.current.pause();
                                    segmentAudioRef.current = null;
                                  }
                                  setPlayingSegmentId(null);
                                } else {
                                  // Stop previous if any
                                  if (segmentAudioRef.current) {
                                    segmentAudioRef.current.pause();
                                    segmentAudioRef.current = null;
                                  }
                                  const audioUrl = api.audioDataToUrl(audio.audioData, audio.mimeType);
                                  const audioEl = new Audio(audioUrl);
                                  audioEl.onended = () => {
                                    setPlayingSegmentId(null);
                                    segmentAudioRef.current = null;
                                    // Mark as listened when playback finishes
                                    setListenedSegments(prev => new Set(prev).add(segId));
                                  };
                                  audioEl.play().catch(() => {
                                    setPlayingSegmentId(null);
                                    segmentAudioRef.current = null;
                                  });
                                  segmentAudioRef.current = audioEl;
                                  setPlayingSegmentId(segId);
                                }
                              }}
                              disabled={isRegenerating}
                              className="w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 transition-all hover:scale-110 disabled:opacity-50"
                              style={{ background: isPlaying ? theme.primary : `${theme.primary}30` }}
                            >
                              {isPlaying ? (
                                <Pause size={14} className="text-t-text1" />
                              ) : (
                                <Play size={14} className="ml-0.5" style={{ color: theme.primaryLight }} />
                              )}
                            </button>
                            
                            {/* Segment info */}
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2">
                                <span className="text-sm font-medium text-t-text2">{audio.speaker}</span>
                                {isListened && (
                                  <Check size={13} className="text-green-400 flex-shrink-0" />
                                )}
                              </div>
                              <p className="text-xs text-t-text3 truncate mt-0.5">{audio.text}</p>
                            </div>
                            
                            {/* Per-line regenerate button */}
                            <button
                              onClick={() => regenerateVoiceForLine(section, section.id, audioIndex, audio)}
                              disabled={isRegenerating || voiceGeneration.status === 'processing'}
                              className="w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0 text-t-text3 hover:text-t-text1 hover:bg-t-card-hover transition-all disabled:opacity-40"
                              title={language === 'zh' ? '重新生成此行' : 'Regenerate this line'}
                            >
                              {isRegenerating ? (
                                <Loader2 size={13} className="animate-spin" />
                              ) : (
                                <RefreshCw size={13} />
                              )}
                            </button>
                            
                            {/* Line index */}
                            <span className="text-xs text-t-text3 flex-shrink-0">#{audio.lineIndex + 1}</span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Generate all button */}
        {!allCompleted && (
          <button
            onClick={() => performVoiceGeneration()}
            disabled={voiceGeneration.status === 'processing'}
            className="w-full flex items-center justify-center gap-3 px-5 py-4 rounded-xl text-base text-t-text1 font-medium transition-all hover:scale-[1.02] disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:scale-100"
            style={{ background: `${theme.primary}80` }}
          >
            {voiceGeneration.status === 'processing' ? (
              <Loader2 size={22} className="animate-spin" />
            ) : (
              <Mic2 size={22} />
            )}
            {language === 'zh' ? '一键生成全部' : 'Generate All Sections'}
          </button>
        )}

        {/* Listen warning dialog */}
        {showListenWarning && (
          <div className="fixed inset-0 z-50 flex items-center justify-center" onClick={() => setShowListenWarning(false)}>
            <div 
              className="mx-4 max-w-md w-full rounded-2xl border border-t-border p-6 space-y-4 shadow-2xl"
              style={{ background: 'var(--t-bg-base)' }}
              onClick={e => e.stopPropagation()}
            >
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full flex items-center justify-center bg-amber-500/20">
                  <Headphones size={20} className="text-amber-400" />
                </div>
                <h3 className="text-lg font-semibold text-t-text1">
                  {language === 'zh' ? '尚未全部审听' : 'Not all clips reviewed'}
                </h3>
              </div>
              <p className="text-sm text-t-text2">
                {language === 'zh' 
                  ? `您还有 ${totalSegments - totalListened} 条音频未审听。确定跳过审听继续下一步吗？`
                  : `You have ${totalSegments - totalListened} audio clip${totalSegments - totalListened > 1 ? 's' : ''} not yet reviewed. Continue anyway?`
                }
              </p>
              <div className="flex items-center gap-3 justify-end pt-2">
                <button
                  onClick={() => setShowListenWarning(false)}
                  className="px-4 py-2 rounded-lg text-sm text-t-text2 hover:text-t-text1 hover:bg-t-card-hover transition-colors"
                >
                  {language === 'zh' ? '返回审听' : 'Go back'}
                </button>
                <button
                  onClick={() => {
                    setShowListenWarning(false);
                    // Proceed to next step directly
                    const hasMedia = specData.addBgm || specData.addSoundEffects || specData.hasVisualContent;
                    if (!hasMedia) {
                      dispatch(actions.updateProductionPhase('media-production', 'completed', 100));
                      setCurrentStep(7);
                      setTimeout(() => { performMixing(); }, 100);
                    } else {
                      // Go to Step 6 (media selection) - don't auto-start production
                      // User needs to confirm their media selections first
                      setCurrentStep(6);
                    }
                  }}
                  className="px-4 py-2 rounded-lg text-sm font-medium text-t-text1 transition-all hover:scale-105"
                  style={{ background: theme.primary }}
                >
                  {language === 'zh' ? '继续下一步' : 'Continue anyway'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  };

  // Render Step 6: Media Production (NEW)
  const renderMediaProductionStep = () => {
    const { mediaProduction } = production;
    const hasBgm = specData.addBgm;
    const hasSfx = specData.addSoundEffects;
    const hasImages = specData.hasVisualContent;
    
    // --- Phase 1: Selection UI (before production starts) ---
    if (!mediaSelectionsConfirmed) {
      // Load media library items
      const allMediaItems = loadMediaItems();
      const bgmLibraryItems = allMediaItems.filter(item => item.type === 'bgm');
      
      return (
        <div className="space-y-6">
          <div className="text-center py-4">
            <div 
              className="w-16 h-16 mx-auto mb-4 rounded-full flex items-center justify-center"
              style={{ background: `${theme.primary}20` }}
            >
              <Music size={32} style={{ color: theme.primaryLight }} />
            </div>
            <h3 className="text-xl font-medium text-t-text1 mb-2">
              {language === 'zh' ? '媒体选择' : 'Media Selection'}
            </h3>
            <p className="text-sm text-t-text3">
              {language === 'zh' ? '为您的项目选择背景音乐' : 'Choose background music for your project'}
            </p>
          </div>

          {/* BGM Selection */}
          {hasBgm && (
            <div className="p-4 rounded-xl border border-t-border bg-t-card">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <Music size={20} style={{ color: theme.primaryLight }} />
                  <span className="font-medium text-t-text1">
                    {language === 'zh' ? '背景音乐 (BGM)' : 'Background Music (BGM)'}
                  </span>
                </div>
                <button
                  onClick={() => setMediaPickerOpen('bgm')}
                  className="px-3 py-1.5 rounded-lg text-sm font-medium transition-all hover:opacity-90"
                  style={{ 
                    background: bgmSelection ? `${theme.primary}15` : theme.primary, 
                    color: bgmSelection ? theme.primaryLight : 'white'
                  }}
                >
                  {bgmSelection 
                    ? (language === 'zh' ? '更改' : 'Change')
                    : (language === 'zh' ? '选择 BGM' : 'Select BGM')
                  }
                </button>
              </div>
              
              {/* BGM Selection Display */}
              {bgmSelection ? (
                <div className="p-3 rounded-lg bg-t-card-hover border border-t-border-lt">
                  <div className="flex items-center gap-2 text-sm">
                    <Check size={16} style={{ color: theme.primaryLight }} />
                    <span className="text-t-text2">
                      {bgmSelection.source === 'preset' && bgmSelection.presetId && (() => {
                        const preset = PRESET_BGM_LIST.find(p => p.id === bgmSelection.presetId);
                        if (!preset) return 'Preset BGM';
                        return preset.name[language as 'zh' | 'en'] || preset.name.en;
                      })()}
                      {bgmSelection.source === 'library' && bgmSelection.mediaItem && (
                        bgmSelection.mediaItem.name
                      )}
                      {bgmSelection.source === 'generate' && (
                        language === 'zh' ? `生成: ${bgmSelection.prompt}` : `Generate: ${bgmSelection.prompt}`
                      )}
                    </span>
                  </div>
                </div>
              ) : (
                <div className="p-3 rounded-lg bg-t-card-hover border border-dashed border-t-border text-center text-sm text-t-text3">
                  {language === 'zh' ? '未选择 BGM' : 'No BGM selected'}
                </div>
              )}
            </div>
          )}

          {/* No media message */}
          {!hasBgm && !hasSfx && !hasImages && (
            <div className="text-center py-10 text-t-text3">
              {language === 'zh' ? '此项目不需要额外媒体' : 'No additional media needed for this project'}
            </div>
          )}

          {/* Confirm & Start Production Button */}
          {hasBgm && (
            <button
              onClick={() => performMediaProduction()}
              disabled={!bgmSelection}
              className="w-full flex items-center justify-center gap-2 px-6 py-3 rounded-xl text-base text-t-text1 font-medium transition-all hover:scale-[1.02] disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:scale-100"
              style={{ background: theme.primary }}
            >
              <Sparkles size={20} />
              {language === 'zh' ? '确认并开始制作' : 'Confirm & Start Production'}
            </button>
          )}

          {/* Media Picker Modal */}
          {mediaPickerOpen === 'bgm' && (
            <MediaPickerModal
              mode="bgm"
              prompt={specData.toneAndExpression || ''}
              libraryItems={bgmLibraryItems}
              preSelectedId={bgmSelection?.source === 'library' ? bgmSelection.mediaItem?.id : undefined}
              preSelectedPresetId={bgmSelection?.source === 'preset' ? bgmSelection.presetId : undefined}
              aiRecommendedPresetId={bgmRecommendation?.presetId}
              aiIdealDescription={bgmRecommendation?.description}
              projectItemIds={[]}
              onConfirm={(result) => {
                setBgmSelection(result);
                setMediaPickerOpen(null);
              }}
              onClose={() => setMediaPickerOpen(null)}
            />
          )}
        </div>
      );
    }
    
    // --- Phase 2: Production Progress UI (after confirmation) ---
    return (
      <div className="space-y-4 sm:space-y-6">
        <div className="text-center py-3 sm:py-6">
          <div 
            className="w-12 h-12 sm:w-20 sm:h-20 mx-auto mb-3 sm:mb-5 rounded-full flex items-center justify-center"
            style={{ background: `${theme.primary}20` }}
          >
            {mediaProduction.status === 'completed' ? (
              <>
                <Check size={24} className="sm:hidden" style={{ color: theme.primaryLight }} />
                <Check size={40} className="hidden sm:block" style={{ color: theme.primaryLight }} />
              </>
            ) : (
              <>
                <Music size={24} className={`sm:hidden ${mediaProduction.status === 'processing' ? 'animate-pulse' : ''}`} style={{ color: theme.primaryLight }} />
                <Music size={40} className={`hidden sm:block ${mediaProduction.status === 'processing' ? 'animate-pulse' : ''}`} style={{ color: theme.primaryLight }} />
              </>
            )}
          </div>
          <h3 className="text-base sm:text-xl font-medium text-t-text1 mb-1 sm:mb-2">
            {language === 'zh' ? '媒体制作' : 'Media Production'}
          </h3>
          <p className="text-sm sm:text-base text-t-text3">
            {mediaProduction.status === 'completed' 
              ? (language === 'zh' ? '媒体制作完成' : 'Media production complete')
              : mediaProduction.currentTask || (language === 'zh' ? '准备中...' : 'Preparing...')
            }
          </p>
        </div>

        {/* Progress bar */}
        <div className="space-y-3">
          <div className="flex items-center justify-between text-sm text-t-text3">
            <span>{language === 'zh' ? '进度' : 'Progress'}</span>
            <span>{mediaProduction.progress}%</span>
          </div>
          <div className="h-3 rounded-full bg-t-card-hover overflow-hidden">
            <div 
              className="h-full rounded-full transition-all duration-500"
              style={{ width: `${mediaProduction.progress}%`, background: theme.primary }}
            />
          </div>
        </div>

        {/* Media tasks */}
        <div className="grid grid-cols-3 gap-2 sm:gap-4">
          {hasBgm && (
            <div 
              className="p-3 sm:p-5 rounded-xl border border-t-border text-center"
              style={{ background: 'var(--t-bg-card)' }}
            >
              <Music size={20} className="sm:hidden mx-auto mb-2" style={{ color: theme.primaryLight }} />
              <Music size={28} className="hidden sm:block mx-auto mb-3" style={{ color: theme.primaryLight }} />
              <p className="text-xs sm:text-sm text-t-text2">BGM</p>
              {mediaProduction.progress > 33 && (
                <Check size={14} className="mx-auto mt-1 sm:mt-2" style={{ color: theme.primaryLight }} />
              )}
            </div>
          )}
          {hasSfx && (
            <div 
              className="p-3 sm:p-5 rounded-xl border border-t-border text-center"
              style={{ background: 'var(--t-bg-card)' }}
            >
              <Volume2 size={20} className="sm:hidden mx-auto mb-2" style={{ color: theme.primaryLight }} />
              <Volume2 size={28} className="hidden sm:block mx-auto mb-3" style={{ color: theme.primaryLight }} />
              <p className="text-xs sm:text-sm text-t-text2">SFX</p>
              {mediaProduction.progress > 66 && (
                <Check size={14} className="mx-auto mt-1 sm:mt-2" style={{ color: theme.primaryLight }} />
              )}
            </div>
          )}
          {hasImages && (
            <div 
              className="p-3 sm:p-5 rounded-xl border border-t-border text-center"
              style={{ background: 'var(--t-bg-card)' }}
            >
              <Image size={20} className="sm:hidden mx-auto mb-2" style={{ color: theme.primaryLight }} />
              <Image size={28} className="hidden sm:block mx-auto mb-3" style={{ color: theme.primaryLight }} />
              <p className="text-xs sm:text-sm text-t-text2">{language === 'zh' ? '图片' : 'Images'}</p>
              {mediaProduction.progress === 100 && (
                <Check size={14} className="mx-auto mt-1 sm:mt-2" style={{ color: theme.primaryLight }} />
              )}
            </div>
          )}
          {!hasBgm && !hasSfx && !hasImages && (
            <div className="col-span-3 text-center py-6 sm:py-10 text-t-text3 text-sm sm:text-base">
              {language === 'zh' ? '此模板不需要额外媒体' : 'No additional media for this template'}
            </div>
          )}
        </div>

        {/* Audio Preview - shown when generation is completed */}
        {mediaProduction.status === 'completed' && (mediaProduction.bgmAudio || (mediaProduction.sfxAudios && mediaProduction.sfxAudios.length > 0)) && (
          <div className="space-y-3 mt-2">
            <h4 className="text-xs sm:text-sm font-medium text-t-text2">
              {language === 'zh' ? '生成预览' : 'Generated Preview'}
            </h4>

            {/* BGM Preview */}
            {mediaProduction.bgmAudio && (
              <div
                className="flex items-center gap-3 p-2.5 sm:p-3 rounded-lg border border-t-border"
                style={{ background: 'var(--t-bg-card)' }}
              >
                <button
                  disabled={regeneratingId === 'bgm'}
                  onClick={() => {
                    if (playingMediaId === 'bgm') {
                      mediaAudioRef.current?.pause();
                      mediaAudioRef.current = null;
                      setPlayingMediaId(null);
                    } else {
                      if (mediaAudioRef.current) {
                        mediaAudioRef.current.pause();
                        mediaAudioRef.current = null;
                      }
                      const url = mediaProduction.bgmAudio!.audioUrl
                        || api.audioDataToUrl(mediaProduction.bgmAudio!.audioData!, mediaProduction.bgmAudio!.mimeType);
                      const audio = new Audio(url);
                      audio.onended = () => { setPlayingMediaId(null); mediaAudioRef.current = null; };
                      audio.onerror = () => { setPlayingMediaId(null); mediaAudioRef.current = null; };
                      audio.play().catch(() => { setPlayingMediaId(null); });
                      mediaAudioRef.current = audio;
                      setPlayingMediaId('bgm');
                    }
                  }}
                  className="w-8 h-8 sm:w-9 sm:h-9 rounded-full flex items-center justify-center flex-shrink-0 transition-all hover:opacity-80"
                  style={{ background: theme.primary, opacity: regeneratingId === 'bgm' ? 0.5 : 1 }}
                >
                  {regeneratingId === 'bgm' ? (
                    <>
                      <Loader2 size={12} className="text-white animate-spin sm:hidden" />
                      <Loader2 size={14} className="text-white animate-spin hidden sm:block" />
                    </>
                  ) : playingMediaId === 'bgm' ? (
                    <>
                      <Square size={12} className="text-white sm:hidden" />
                      <Square size={14} className="text-white hidden sm:block" />
                    </>
                  ) : (
                    <>
                      <Play size={12} className="text-white ml-0.5 sm:hidden" />
                      <Play size={14} className="text-white ml-0.5 hidden sm:block" />
                    </>
                  )}
                </button>
                <div className="flex-1 min-w-0">
                  <p className="text-xs sm:text-sm font-medium text-t-text1 truncate">
                    <Music size={14} className="inline mr-1.5" style={{ color: theme.primaryLight }} />
                    BGM
                  </p>
                  <p className="text-xs text-t-text3 truncate">{specData.toneAndExpression || 'Background music'}</p>
                </div>
                <button
                  disabled={regeneratingId !== null}
                  onClick={() => handleRegenMedia('bgm')}
                  className="w-7 h-7 sm:w-8 sm:h-8 rounded-lg flex items-center justify-center flex-shrink-0 border border-t-border transition-all hover:bg-t-card-hover disabled:opacity-40"
                  title={language === 'zh' ? '重新生成' : 'Regenerate'}
                >
                  <RefreshCw size={12} className={`text-t-text3 sm:hidden ${regeneratingId === 'bgm' ? 'animate-spin' : ''}`} />
                  <RefreshCw size={14} className={`text-t-text3 hidden sm:block ${regeneratingId === 'bgm' ? 'animate-spin' : ''}`} />
                </button>
              </div>
            )}

            {/* SFX Previews */}
            {mediaProduction.sfxAudios?.map((sfx, idx) => {
              const sfxId = `sfx-${idx}`;
              const isRegenerating = regeneratingId === sfxId;
              return (
              <div
                key={sfxId}
                className="flex items-center gap-3 p-2.5 sm:p-3 rounded-lg border border-t-border"
                style={{ background: 'var(--t-bg-card)' }}
              >
                <button
                  disabled={isRegenerating}
                  onClick={() => {
                    if (playingMediaId === sfxId) {
                      mediaAudioRef.current?.pause();
                      mediaAudioRef.current = null;
                      setPlayingMediaId(null);
                    } else {
                      if (mediaAudioRef.current) {
                        mediaAudioRef.current.pause();
                        mediaAudioRef.current = null;
                      }
                      const url = api.audioDataToUrl(sfx.audioData, sfx.mimeType);
                      const audio = new Audio(url);
                      audio.onended = () => { setPlayingMediaId(null); mediaAudioRef.current = null; };
                      audio.onerror = () => { setPlayingMediaId(null); mediaAudioRef.current = null; };
                      audio.play().catch(() => { setPlayingMediaId(null); });
                      mediaAudioRef.current = audio;
                      setPlayingMediaId(sfxId);
                    }
                  }}
                  className="w-8 h-8 sm:w-9 sm:h-9 rounded-full flex items-center justify-center flex-shrink-0 transition-all hover:opacity-80"
                  style={{ background: theme.primary, opacity: isRegenerating ? 0.5 : 1 }}
                >
                  {isRegenerating ? (
                    <>
                      <Loader2 size={12} className="text-white animate-spin sm:hidden" />
                      <Loader2 size={14} className="text-white animate-spin hidden sm:block" />
                    </>
                  ) : playingMediaId === sfxId ? (
                    <>
                      <Square size={12} className="text-white sm:hidden" />
                      <Square size={14} className="text-white hidden sm:block" />
                    </>
                  ) : (
                    <>
                      <Play size={12} className="text-white ml-0.5 sm:hidden" />
                      <Play size={14} className="text-white ml-0.5 hidden sm:block" />
                    </>
                  )}
                </button>
                <div className="flex-1 min-w-0">
                  <p className="text-xs sm:text-sm font-medium text-t-text1 truncate">
                    <Volume2 size={14} className="inline mr-1.5" style={{ color: theme.primaryLight }} />
                    {sfx.name}
                  </p>
                  <p className="text-xs text-t-text3 truncate">{sfx.prompt}</p>
                </div>
                <button
                  disabled={regeneratingId !== null}
                  onClick={() => handleRegenMedia('sfx', idx)}
                  className="w-7 h-7 sm:w-8 sm:h-8 rounded-lg flex items-center justify-center flex-shrink-0 border border-t-border transition-all hover:bg-t-card-hover disabled:opacity-40"
                  title={language === 'zh' ? '重新生成' : 'Regenerate'}
                >
                  <RefreshCw size={12} className={`text-t-text3 sm:hidden ${isRegenerating ? 'animate-spin' : ''}`} />
                  <RefreshCw size={14} className={`text-t-text3 hidden sm:block ${isRegenerating ? 'animate-spin' : ''}`} />
                </button>
              </div>
              );
            })}
          </div>
        )}
      </div>
    );
  };

  // Format duration from ms to mm:ss
  const formatDuration = (ms: number): string => {
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  };

  // Render Step 7: Mixing & Editing (NEW)
  // Render Step 7: Mixing & Editing - uses shared MixingStep
  const renderMixingStep = () => (
    <MixingStep
      production={production}
      onRetryMixing={performMixing}
      downloadTitle={specData.storyTitle || 'mixed-audio'}
      hasVisualContent={specData.hasVisualContent}
    />
  );

  // Render Step 8: Save (Post-processing)
  const renderSaveStep = () => {
    const mixedOutput = production.mixingEditing.output;
    
    const handleDownloadFinal = () => {
      if (mixedOutput?.audioData) {
        const filename = `${specData.storyTitle || 'mixed-audio'}.wav`;
        api.downloadAudio(mixedOutput.audioData, mixedOutput.mimeType, filename);
      }
    };

    return (
    <div className="space-y-4 sm:space-y-6">
      {/* Audio Preview */}
      <div 
        className="rounded-xl p-3 sm:p-5 border border-t-border"
        style={{ background: 'var(--t-bg-card)' }}
      >
        <div className="flex items-center gap-2 mb-4">
          <Headphones size={18} style={{ color: theme.primaryLight }} />
          <span className="text-t-text1 text-base font-medium">
            {language === 'zh' ? '最终预览' : 'Final Preview'}
          </span>
          {mixedOutput && (
            <span className="text-t-text3 text-sm ml-auto">
              {formatDuration(mixedOutput.durationMs)}
            </span>
          )}
        </div>
        
        {mixedOutput ? (
          <>
            {/* Native audio player */}
            <audio 
              controls 
              className="w-full mb-4"
              src={api.audioDataToUrl(mixedOutput.audioData, mixedOutput.mimeType)}
              style={{ height: '40px' }}
            />
            
            {/* Download button */}
            <button
              onClick={handleDownloadFinal}
              className="w-full flex items-center justify-center gap-2 py-2.5 rounded-lg text-t-text1 text-sm font-medium border border-t-border transition-all hover:bg-t-card-hover"
            >
              <Save size={16} />
              {language === 'zh' ? '下载音频' : 'Download Audio'}
            </button>
          </>
        ) : (
          <div className="py-4 text-center space-y-3">
            <p className="text-t-text3 text-sm">
              {production.mixingEditing.error
                ? (language === 'zh' ? `混音失败: ${production.mixingEditing.error}` : `Mixing failed: ${production.mixingEditing.error}`)
                : (language === 'zh' ? '没有可用的音频' : 'No audio available')
              }
            </p>
            <button
              onClick={() => {
                dispatch(actions.updateProductionPhase('mixing-editing', 'idle', 0));
                dispatch(actions.setMixingError(''));
                setTimeout(() => performMixing(), 100);
              }}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-t-text1 transition-all hover:scale-105"
              style={{ background: theme.primary }}
            >
              <RefreshCw size={16} />
              {language === 'zh' ? '重新混音' : 'Retry Mixing'}
            </button>
          </div>
        )}
      </div>

      {/* Project summary */}
      <div 
        className="rounded-xl p-4 sm:p-6 border border-t-border"
        style={{ background: `${theme.primary}10` }}
      >
        <div className="flex items-center gap-3 sm:gap-4 mb-3 sm:mb-5">
          <div 
            className="w-10 h-10 sm:w-14 sm:h-14 rounded-xl flex items-center justify-center flex-shrink-0"
            style={{ background: `${theme.primary}30` }}
          >
            <ReligionIcon size={20} color={theme.primaryLight} className="sm:hidden" />
            <ReligionIcon size={28} color={theme.primaryLight} className="hidden sm:block" />
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="text-lg sm:text-2xl font-serif text-t-text1 truncate">{specData.storyTitle}</h3>
            {specData.subtitle && (
              <p className="text-sm sm:text-base text-t-text2 italic truncate">{specData.subtitle}</p>
            )}
            <p className="text-xs sm:text-base text-t-text3 truncate">
              {specData.targetAudience} · {specData.formatAndDuration}
            </p>
          </div>
        </div>

        <div className="space-y-3 sm:space-y-4 text-sm sm:text-base">
          <p className="text-t-text2 line-clamp-1">{specData.toneAndExpression}</p>
          <div className="flex items-center gap-3 sm:gap-4 text-xs sm:text-sm text-t-text2 flex-wrap">
            <span>{scriptSections.length} {language === 'zh' ? '段落' : 'sections'}</span>
            <span>·</span>
            <span>{extractedCharacters.length} {language === 'zh' ? '角色' : 'characters'}</span>
            {specData.addBgm && (
              <>
                <span>·</span>
                <span className="flex items-center gap-1" style={{ color: theme.primaryLight }}>
                  <Music size={14} /> BGM
                </span>
              </>
            )}
            {specData.addSoundEffects && (
              <>
                <span>·</span>
                <span className="flex items-center gap-1" style={{ color: theme.primaryLight }}>
                  <Volume2 size={14} /> SFX
                </span>
              </>
            )}
            {specData.hasVisualContent && (
              <>
                <span>·</span>
                <span className="flex items-center gap-1" style={{ color: theme.primaryLight }}>
                  <Image size={14} /> {language === 'zh' ? '视觉' : 'Visual'}
                </span>
              </>
            )}
          </div>
        </div>

        {/* Template badge */}
        {selectedTemplate && (
          <div className="mt-5 pt-5 border-t border-t-border">
            <div className="flex items-center gap-2 text-sm text-t-text3">
              <span>{language === 'zh' ? '模板:' : 'Template:'}</span>
              <span className="text-t-text2">
                {language === 'zh' ? selectedTemplate.nameZh : selectedTemplate.name}
              </span>
            </div>
          </div>
        )}
      </div>

      <p className="text-center text-t-text3 text-sm">
        {language === 'zh' ? '点击下方按钮保存项目' : 'Click the button below to save your project'}
      </p>
    </div>
    );
  };

  // Main render step content for 8-step workflow
  const renderStepContent = () => {
    switch (currentStep) {
      case 1: return renderTemplateStep();        // Template Selection
      case 2: return renderSpecStep();            // Project Spec
      case 3: return renderContentInputStep();    // Content Input
      case 4: return renderScriptStep();          // Script Generation
      case 5: return renderVoiceGenerationStep(); // Voice Generation
      case 6: return renderMediaProductionStep(); // Media Production
      case 7: return renderMixingStep();          // Mixing & Editing
      case 8: return renderSaveStep();            // Save
      default: return null;
    }
  };

  // Load available voices on mount
  useEffect(() => {
    setAvailableVoices(loadVoiceCharacters());
    loadVoiceCharactersFromCloud()
      .then(voices => { if (voices.length > 0) setAvailableVoices(voices); })
      .catch(err => console.error('Failed to load voices from cloud:', err));
    
    // Load system voices from backend
    api.getVoices()
      .then(voices => setSystemVoices(voices))
      .catch(err => console.error('Failed to load system voices:', err));
  }, []);

  // Initialize from Landing page data if provided
  useEffect(() => {
    if (initialData) {
      // Map format to template ID
      const templateId = initialData.selectedFormat;
      const template = PROJECT_TEMPLATES.find(t => t.id === templateId);
      
      if (template) {
        // Select the template
        dispatch(actions.selectTemplate(templateId));
        
        // Set template config from Landing page mediaConfig
        setTemplateConfig({
          voiceCount: initialData.mediaConfig.voiceCount,
          addBgm: initialData.mediaConfig.addBgm,
          addSoundEffects: initialData.mediaConfig.addSoundEffects,
          hasVisualContent: initialData.mediaConfig.hasVisualContent,
        });
        
        // Apply template defaults with Landing page media config overrides
        dispatch(actions.setSpec({
          storyTitle: '',
          subtitle: '',
          targetAudience: template.defaultSpec.targetAudience,
          formatAndDuration: template.defaultSpec.formatAndDuration,
          toneAndExpression: template.defaultSpec.toneAndExpression,
          addBgm: initialData.mediaConfig.addBgm,
          addSoundEffects: initialData.mediaConfig.addSoundEffects,
          hasVisualContent: initialData.mediaConfig.hasVisualContent,
        }));
      }
      
      // Set custom description if provided
      if (initialData.projectDescription) {
        setCustomDescription(initialData.projectDescription);
      }
    }
  }, [initialData]);

  // Initialize from Creative Mode: use AI to extract project spec from the brainstorming conversation
  useEffect(() => {
    if (!creativeContext) return;

    creativeContextRef.current = creativeContext;
    setIsExtractingCreativeContext(true);

    const prompt = buildCreativeContextExtractionPrompt(creativeContext);
    api.generateText(prompt)
      .then(responseText => {
        const jsonMatch = responseText.match(/```(?:json)?\s*([\s\S]*?)```/) ||
                          responseText.match(/\{[\s\S]*\}/);
        const jsonStr = jsonMatch ? (jsonMatch[1] || jsonMatch[0]).trim() : responseText;
        const parsed = JSON.parse(jsonStr) as CreativeContextExtraction;

        dispatch(actions.setSpec({
          storyTitle: parsed.storyTitle || '',
          subtitle: parsed.subtitle || '',
          targetAudience: parsed.targetAudience || '',
          formatAndDuration: parsed.formatAndDuration || '',
          toneAndExpression: parsed.toneAndExpression || '',
          addBgm: parsed.addBgm ?? true,
          addSoundEffects: parsed.addSoundEffects ?? false,
          hasVisualContent: parsed.hasVisualContent ?? false,
        }));

        if (parsed.subtitle) {
          setShowSubtitle(true);
        }

        if (parsed.contentBrief) {
          dispatch(actions.setTextContent(parsed.contentBrief));
        }
      })
      .catch(err => {
        console.error('Creative context extraction failed:', err);
      })
      .finally(() => {
        setIsExtractingCreativeContext(false);
      });
  }, [creativeContext]);

  // --- Draft Persistence: Restore on mount ---
  useEffect(() => {
    // Skip if initialData or creativeContext is provided (fresh flow)
    if (initialData || creativeContext) return;
    
    const draft = loadDraft();
    if (draft) {
      // Restore reducer state
      dispatch(actions.restoreDraft(draft));
      // Restore local UI state
      setCurrentStep(draft.currentStep);
      setCustomDescription(draft.localState.customDescription);
      setTemplateConfig(draft.localState.templateConfig);
      setVoicesConfirmed(draft.localState.voicesConfirmed);
      // Show restoration banner
      setDraftBanner({ visible: true, savedAt: draft.savedAt });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Run once on mount

  // --- Draft Persistence: Auto-save on step changes and state mutations ---
  useEffect(() => {
    // Don't save if we're on step 1 with no data yet (nothing to persist)
    if (currentStep === 1 && !selectedTemplateId && !customDescription.trim()) return;

    // Debounce saves to avoid excessive writes
    if (draftSaveTimer.current) clearTimeout(draftSaveTimer.current);
    draftSaveTimer.current = setTimeout(() => {
      saveDraft(currentStep, state, {
        customDescription,
        templateConfig,
        voicesConfirmed,
      });
    }, 500);

    return () => {
      if (draftSaveTimer.current) clearTimeout(draftSaveTimer.current);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentStep, state, customDescription, templateConfig, voicesConfirmed]);

  // Parse streaming text progressively for UI rendering
  useEffect(() => {
    if (!streamingText) {
      setStreamingParsed({ completeSections: [], partialSection: null });
      return;
    }
    const parsed = parseStreamingScriptSections(streamingText);
    setStreamingParsed({
      completeSections: parsed.completeSections,
      partialSection: parsed.partialSection,
    });
  }, [streamingText]);

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div 
        className="rounded-3xl w-full max-w-4xl max-h-[90vh] overflow-hidden flex flex-col animate-slide-up border border-t-border"
        style={{ background: 'var(--t-bg-base)' }}
      >
        {/* Header */}
        <div className="px-4 sm:px-8 py-3 sm:py-5 flex items-center justify-between border-b border-t-border">
          <div className="flex items-center gap-3 sm:gap-4">
            <div 
              className="w-9 h-9 sm:w-12 sm:h-12 rounded-xl flex items-center justify-center flex-shrink-0"
              style={{ background: `${theme.primary}30` }}
            >
              <ReligionIcon size={20} color={theme.primaryLight} className="sm:hidden" />
              <ReligionIcon size={24} color={theme.primaryLight} className="hidden sm:block" />
            </div>
            <div className="min-w-0">
              <h2 className="text-base sm:text-xl font-serif text-t-text1 truncate">{t.projectCreator.title}</h2>
              <div className="flex items-center gap-2">
                <p className="text-xs sm:text-sm text-t-text3 truncate">
                  {t.projectCreator.step} {currentStep} {t.projectCreator.of} {STEPS.length} · {STEPS[currentStep - 1]?.title}
                </p>
                {currentStep === 4 && totalLineCount > 0 && (
                  <div className="flex items-center gap-1.5 flex-shrink-0">
                    <div className="w-16 sm:w-20 h-1.5 rounded-full bg-t-border overflow-hidden">
                      <div 
                        className="h-full rounded-full transition-all duration-300"
                        style={{ 
                          width: `${Math.min((totalLineCount / MAX_SCRIPT_LINES) * 100, 100)}%`,
                          background: totalLineCount >= MAX_SCRIPT_LINES ? '#ef4444' : totalLineCount >= MAX_SCRIPT_LINES * 0.8 ? '#f59e0b' : theme.primary 
                        }}
                      />
                    </div>
                    <span className={`text-[10px] tabular-nums ${totalLineCount >= MAX_SCRIPT_LINES ? 'text-red-500' : totalLineCount >= MAX_SCRIPT_LINES * 0.8 ? 'text-amber-500' : 'text-t-text3/60'}`}>
                      {totalLineCount}/{MAX_SCRIPT_LINES}
                    </span>
                  </div>
                )}
              </div>
            </div>
          </div>
          <button onClick={onClose} className="p-1.5 sm:p-2 hover:bg-t-card-hover rounded-lg transition-colors flex-shrink-0">
            <X className="text-t-text3" size={20} />
          </button>
        </div>


        {/* Draft Restored Banner */}
        {draftBanner?.visible && (
          <div 
            className="mx-4 sm:mx-8 mt-3 sm:mt-4 px-3 sm:px-4 py-2 sm:py-3 rounded-xl flex items-center justify-between border border-t-border animate-slide-up gap-2"
            style={{ background: `${theme.primary}15` }}
          >
            <div className="flex items-center gap-3">
              <RefreshCw size={16} style={{ color: theme.primaryLight }} />
              <span className="text-sm text-t-text2">
                {language === 'zh' 
                  ? `已恢复上次的草稿（${new Date(draftBanner.savedAt).toLocaleString('zh-CN')}）` 
                  : `Draft restored from ${new Date(draftBanner.savedAt).toLocaleString()}`
                }
              </span>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={handleDiscardDraft}
                className="text-xs px-3 py-1.5 rounded-lg text-t-text3 hover:text-t-text1 hover:bg-t-card-hover transition-colors"
              >
                {language === 'zh' ? '放弃草稿' : 'Discard'}
              </button>
              <button
                onClick={() => setDraftBanner(null)}
                className="text-xs px-3 py-1.5 rounded-lg transition-colors"
                style={{ background: `${theme.primary}30`, color: theme.primaryLight }}
              >
                {language === 'zh' ? '继续编辑' : 'Continue'}
              </button>
            </div>
          </div>
        )}

        {/* Content */}
        <div className="flex-1 overflow-auto px-4 py-4 sm:px-8 sm:py-8">
          {renderStepContent()}
        </div>

        {/* Bottom Progress Light Beam with Steps */}
        <div className="relative h-2.5 overflow-visible bg-t-card">
          {/* Step segments (hover areas) */}
          <div className="absolute inset-0 flex z-10">
            {STEPS.map((step, index) => {
              const stepWidth = 100 / STEPS.length;
              
              return (
                <div 
                  key={step.id}
                  className="relative flex-1 cursor-pointer transition-all hover:bg-t-card"
                  onMouseEnter={() => {
                    setHoveredStep(step.id);
                    setShowProgressTooltip(true);
                  }}
                  onMouseLeave={() => {
                    setHoveredStep(null);
                    setShowProgressTooltip(false);
                  }}
                  style={{ width: `${stepWidth}%` }}
                >
                  {/* Step divider line */}
                  {index < STEPS.length - 1 && (
                    <div 
                      className="absolute right-0 top-0 bottom-0 w-px"
                      style={{ background: 'var(--t-border)' }}
                    />
                  )}
                </div>
              );
            })}
          </div>
          
          {/* Progress beam with glow effect */}
          <div 
            className="absolute inset-y-0 left-0 transition-all duration-700 ease-out pointer-events-none flex items-center"
            style={{ 
              width: `${getProgressPercentage()}%`,
              background: `linear-gradient(90deg, ${theme.primary}40, ${theme.primary}, ${theme.primaryLight})`,
              boxShadow: `0 0 15px ${theme.primary}60, 0 0 30px ${theme.primary}30, 0 -2px 15px ${theme.primary}40`
            }}
          >
            {/* Animated shimmer effect */}
            <div 
              className="absolute inset-0 opacity-80"
              style={{
                background: `linear-gradient(90deg, transparent 0%, ${theme.primaryLight}80 50%, transparent 100%)`,
                animation: 'shimmer 2.5s ease-in-out infinite',
                backgroundSize: '200% 100%'
              }}
            />
            
            {/* Pulsing glow at the end */}
            <div 
              className="absolute right-0 w-3 h-3 rounded-full animate-pulse"
              style={{ 
                background: theme.primaryLight,
                boxShadow: `0 0 10px ${theme.primaryLight}, 0 0 20px ${theme.primary}`,
                top: '50%',
                transform: 'translateY(-50%)'
              }}
            />
          </div>

          {/* Step indicators */}
          <div className="absolute inset-0 flex pointer-events-none z-20">
            {STEPS.map((step) => {
              const stepWidth = 100 / STEPS.length;
              const isCompleted = currentStep > step.id;
              const isCurrent = currentStep === step.id;
              const isHovered = hoveredStep === step.id;
              
              return (
                <div 
                  key={`indicator-${step.id}`}
                  className="relative flex items-center justify-center"
                  style={{ width: `${stepWidth}%` }}
                >
                  {/* Step number/check icon */}
                  <div
                    className={`absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full flex items-center justify-center text-[10px] font-bold transition-all ${
                      isCurrent ? 'w-6 h-6' : 'w-5 h-5'
                    } ${isHovered ? 'scale-110' : ''}`}
                    style={{
                      background: isCompleted || isCurrent ? theme.primary : 'var(--t-bg-card-hover)',
                      color: isCompleted || isCurrent ? 'var(--t-text-1)' : 'var(--t-text-3)',
                      boxShadow: isCurrent ? `0 0 12px ${theme.primary}80` : isHovered ? `0 0 8px ${theme.primary}40` : 'none',
                      border: isHovered ? `1px solid ${theme.primaryLight}` : 'none'
                    }}
                  >
                    {isCompleted ? <Check size={12} /> : step.id}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Hover tooltip */}
          {showProgressTooltip && hoveredStep !== null && (
            <div 
              className="absolute bottom-full mb-3 pointer-events-none z-30 animate-fade-in"
              style={{
                left: hoveredStep === 1 ? '10%' : hoveredStep === STEPS.length ? '90%' : `${((hoveredStep - 0.5) / STEPS.length) * 100}%`,
                transform: hoveredStep === 1 ? 'translateX(0)' : hoveredStep === STEPS.length ? 'translateX(-100%)' : 'translateX(-50%)'
              }}
            >
              <div 
                className="px-5 py-4 rounded-xl border backdrop-blur-xl shadow-2xl min-w-[240px]"
                style={{ 
                  background: 'var(--t-bg-base)',
                  borderColor: `${theme.primary}40`,
                  boxShadow: `0 10px 40px ${theme.primary}20, 0 0 0 1px ${theme.primary}10`
                }}
              >
                {/* Step Info */}
                <div className="flex items-center gap-3 mb-3">
                  <div
                    className="w-7 h-7 rounded-full flex items-center justify-center text-sm font-bold"
                    style={{
                      background: currentStep >= hoveredStep ? theme.primary : 'var(--t-bg-card-hover)',
                      color: 'var(--t-text-1)'
                    }}
                  >
                    {currentStep > hoveredStep ? <Check size={16} /> : hoveredStep}
                  </div>
                  <div className="flex-1">
                    <div className="font-semibold text-t-text1 text-base">
                      {STEPS[hoveredStep - 1]?.title}
                    </div>
                  </div>
                  {currentStep === hoveredStep && (
                    <div className="text-xs font-medium px-2.5 py-1 rounded" style={{ background: `${theme.primary}30`, color: theme.primaryLight }}>
                      {t.projectCreator.current}
                    </div>
                  )}
                </div>
                <div className="text-sm text-t-text2 mb-4 leading-relaxed">
                  {STEPS[hoveredStep - 1]?.description}
                </div>
                
                {/* Progress info for current or completed steps */}
                {currentStep >= hoveredStep && (
                  <div className="flex items-center gap-2 text-sm px-3 py-2 rounded-lg" style={{ background: `${theme.primary}15` }}>
                    {currentStep === hoveredStep ? (
                      <>
                        <Loader2 size={14} className="animate-spin" style={{ color: theme.primaryLight }} />
                        <span className="text-t-text2">
                          {t.projectCreator.inProgress}
                        </span>
                      </>
                    ) : (
                      <>
                        <Check size={14} style={{ color: theme.primaryLight }} />
                        <span className="text-t-text2">
                          {t.projectCreator.completed}
                        </span>
                      </>
                    )}
                  </div>
                )}
                
                {/* Overall progress */}
                {currentStep === hoveredStep && (
                  <div className="mt-3 pt-3 border-t border-t-border">
                    <div className="flex items-center justify-between text-xs text-t-text2 mb-1">
                      <span>{t.projectCreator.overall}</span>
                      <span className="font-medium text-t-text1">{Math.round(getProgressPercentage())}%</span>
                    </div>
                    <div className="flex items-center gap-1.5 text-xs text-t-text2">
                      <span>⏱</span>
                      <span>
                        {t.projectCreator.estimated}
                        {getEstimatedTime()}
                        {t.projectCreator.minutes}
                      </span>
                    </div>
                  </div>
                )}
              </div>
              {/* Tooltip arrow */}
              <div 
                className="absolute top-full left-1/2 -translate-x-1/2 w-0 h-0"
                style={{
                  borderLeft: '8px solid transparent',
                  borderRight: '8px solid transparent',
                  borderTop: `8px solid ${theme.primary}40`
                }}
              />
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-8 py-5 border-t border-t-border flex items-center justify-between">
          <button
            onClick={currentStep === 1 ? onClose : handleBack}
            className="flex items-center gap-2 px-5 py-2.5 rounded-lg text-base text-t-text2 hover:text-t-text1 hover:bg-t-card transition-colors"
          >
            <ChevronLeft size={22} />
            {currentStep === 1 ? t.projectCreator.buttons.cancel : t.projectCreator.buttons.back}
          </button>

          <div className="flex items-center gap-3">
            {/* Skip for now - available from step 3 onwards when title is set */}
            {currentStep >= 3 && specData.storyTitle.trim().length > 0 && (
              <button
                onClick={handleSkipAndSave}
                className="flex items-center gap-2 px-5 py-2.5 rounded-lg text-base text-t-text3 hover:text-t-text1 hover:bg-t-card-hover transition-colors border border-t-border"
              >
                {language === 'zh' ? '跳过，稍后继续' : 'Skip for now'}
              </button>
            )}

            {currentStep < STEPS.length ? (
              // Only show Next button when canProceed() is true
              canProceed() && (
                <button
                  onClick={handleNext}
                  disabled={isProcessingNext}
                  className={`flex items-center gap-2 px-8 py-2.5 rounded-lg text-base text-t-text1 font-medium transition-all hover:scale-105 ${
                    isProcessingNext ? 'animate-pulse' : ''
                  }`}
                  style={{ 
                    background: theme.primary,
                    boxShadow: isProcessingNext ? `0 0 20px ${theme.glow}, 0 0 40px ${theme.glow}` : 'none'
                  }}
                >
                  {isProcessingNext ? (
                    <>
                      <Loader2 size={22} className="animate-spin" />
                      {t.projectCreator.processing}
                    </>
                  ) : (
                    <>
                      {currentStep >= 3 ? t.projectCreator.buttons.approve : t.projectCreator.buttons.next}
                      <ChevronRight size={22} />
                    </>
                  )}
                </button>
              )
            ) : (
              <button
                onClick={handleCreate}
                className="flex items-center gap-2 px-8 py-2.5 rounded-lg text-base font-medium transition-all hover:scale-105"
                style={{ background: theme.accent, color: theme.primaryDark }}
              >
                <Save size={22} />
                {t.projectCreator.save}
              </button>
            )}
          </div>
        </div>
      </div>

    </div>
  );
}
