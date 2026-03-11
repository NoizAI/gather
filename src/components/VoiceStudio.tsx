import { useState, useRef, useEffect, useCallback } from 'react';
import { useTheme } from '../contexts/ThemeContext';
import { useLanguage } from '../i18n/LanguageContext';
import { useProjects } from '../contexts/ProjectContext';
import { VoiceCharacter } from '../types';
import { Mic, Square, Play, Pause, Download, Trash2, Plus, User, Volume2, Edit2, X, Upload, AudioWaveform, FolderOpen, Link2, Sparkles, RotateCcw, Loader2, Check } from 'lucide-react';
import { designVoice, type VoiceDesignPreview } from '../services/api';
import { 
  loadVoiceCharacters, 
  saveVoiceCharacters, 
  deleteVoiceCharacterFromCloud,
  loadVoiceCharactersFromCloud,
} from '../utils/voiceStorage';
import { processAudioFile, AudioFileTooLargeError } from '../utils/audioTrim';

export function VoiceStudio() {
  const { theme } = useTheme();
  const { t, language } = useLanguage();
  const { projects } = useProjects();
  
  // Characters states - load first to determine default tab
  const [characters, setCharacters] = useState<VoiceCharacter[]>(() => loadVoiceCharacters());
  
  // Tab state - default to 'characters' if there are any characters, otherwise 'record'
  const [activeTab, setActiveTab] = useState<'record' | 'characters'>(() => 
    loadVoiceCharacters().length > 0 ? 'characters' : 'record'
  );
  
  // Recording states
  const [isRecording, setIsRecording] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [duration, setDuration] = useState(0);
  
  // Characters editor states
  const [showCharacterEditor, setShowCharacterEditor] = useState(false);
  const [editingCharacter, setEditingCharacter] = useState<VoiceCharacter | null>(null);
  const [characterForm, setCharacterForm] = useState({
    name: '',
    description: '',
    tags: '',
    audioSampleUrl: '',
    projectIds: [] as string[],
  });
  
  // Project filter
  const [filterProjectId, setFilterProjectId] = useState<string>('');
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [audioUploaded, setAudioUploaded] = useState(false);
  const [playingCharacterId, setPlayingCharacterId] = useState<string | null>(null);
  const [isPlayingPreview, setIsPlayingPreview] = useState(false);
  const audioInputRef = useRef<HTMLInputElement | null>(null);
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);
  
  // Voice design (AI generate) state
  const [designPrompt, setDesignPrompt] = useState('');
  const [isDesigning, setIsDesigning] = useState(false);
  const [designPreviews, setDesignPreviews] = useState<VoiceDesignPreview[]>([]);
  const [designError, setDesignError] = useState<string | null>(null);
  const [playingDesignIdx, setPlayingDesignIdx] = useState<number | null>(null);
  const [selectedDesignIdx, setSelectedDesignIdx] = useState<number | null>(null);
  const designAudioRef = useRef<HTMLAudioElement | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<number | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const characterAudioRef = useRef<HTMLAudioElement | null>(null);

  // Load voices from cloud on mount
  useEffect(() => {
    loadVoiceCharactersFromCloud().then(voices => {
      setCharacters(voices);
      if (voices.length > 0 && activeTab === 'record') {
        setActiveTab('characters');
      }
    });
  }, []);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      if (audioUrl) URL.revokeObjectURL(audioUrl);
    };
  }, [audioUrl]);

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  // Recording functions
  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream);
      mediaRecorderRef.current = mediaRecorder;
      chunksRef.current = [];

      mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      mediaRecorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: 'audio/webm' });
        setAudioUrl(URL.createObjectURL(blob));
        stream.getTracks().forEach((track) => track.stop());
      };

      mediaRecorder.start();
      setIsRecording(true);
      setDuration(0);
      timerRef.current = window.setInterval(() => setDuration((prev) => prev + 1), 1000);
    } catch {
      alert('Unable to access microphone. Please check permissions.');
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
      setIsPaused(false);
      if (timerRef.current) clearInterval(timerRef.current);
    }
  };

  const togglePause = () => {
    if (!mediaRecorderRef.current) return;
    if (isPaused) {
      mediaRecorderRef.current.resume();
      timerRef.current = window.setInterval(() => setDuration((prev) => prev + 1), 1000);
    } else {
      mediaRecorderRef.current.pause();
      if (timerRef.current) clearInterval(timerRef.current);
    }
    setIsPaused(!isPaused);
  };

  const clearRecording = () => { if (audioUrl) URL.revokeObjectURL(audioUrl); setAudioUrl(null); setDuration(0); };

  const downloadRecording = () => {
    if (!audioUrl) return;
    const a = document.createElement('a');
    a.href = audioUrl;
    a.download = `recording-${new Date().toISOString().slice(0, 10)}.webm`;
    a.click();
  };

  const getStatusText = () => {
    if (isRecording) return isPaused ? t.voiceStudio.status.paused : t.voiceStudio.status.recording;
    if (audioUrl) return t.voiceStudio.status.completed;
    return t.voiceStudio.status.ready;
  };

  // Character functions
  const openCharacterEditor = (character?: VoiceCharacter) => {
    if (character) {
      // Editing existing character - show form directly
      setEditingCharacter(character);
      // Prefer refAudioDataUrl (base64) over audioSampleUrl for TTS compatibility
      const audioUrl = character.refAudioDataUrl || character.audioSampleUrl || '';
      setCharacterForm({
        name: character.name,
        description: character.description,
        tags: character.tags.join(', '),
        audioSampleUrl: audioUrl,
        projectIds: character.projectIds || [],
      });
      setAudioUploaded(!!audioUrl); // Has audio if URL exists
    } else {
      // New character - start with upload flow
      setEditingCharacter(null);
      setCharacterForm({
        name: '',
        description: '',
        tags: '',
        audioSampleUrl: '',
        projectIds: [],
      });
      setAudioUploaded(false);
    }
    setIsAnalyzing(false);
    resetDesignState();
    setShowCharacterEditor(true);
  };

  const handleAudioUpload = async (file: File) => {
    setIsAnalyzing(true);

    try {
      const { dataUrl, wasTrimmed } = await processAudioFile(file);
      setCharacterForm(prev => ({ ...prev, audioSampleUrl: dataUrl }));

      await new Promise(resolve => setTimeout(resolve, 1500));

      const fileName = file.name.replace(/\.[^/.]+$/, '');
      const suggestedName = fileName.replace(/[-_]/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
      
      setCharacterForm(prev => ({
        ...prev,
        name: suggestedName || 'Voice Character',
        description: `Voice character created from ${file.name}${wasTrimmed ? ' (trimmed to 30s)' : ''}`,
        tags: 'custom, uploaded',
      }));
      
      setIsAnalyzing(false);
      setAudioUploaded(true);
    } catch (err) {
      setIsAnalyzing(false);
      if (err instanceof AudioFileTooLargeError) {
        alert(language === 'zh' ? '文件大小超过 5MB 限制' : 'File exceeds the 5 MB size limit');
      } else {
        alert(language === 'zh' ? '音频文件处理失败' : 'Failed to process audio file');
        console.error('Audio upload error:', err);
      }
    }
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file && file.type.startsWith('audio/')) {
      handleAudioUpload(file);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file && file.type.startsWith('audio/')) {
      handleAudioUpload(file);
    }
  };

  const resetAudioUpload = () => {
    // Data URLs don't need revoking (unlike blob URLs)
    setCharacterForm(prev => ({
      ...prev,
      audioSampleUrl: '',
      name: '',
      description: '',
      tags: '',
    }));
    setAudioUploaded(false);
  };

  // --- Voice Design (AI Generate) handlers ---
  const resetDesignState = () => {
    setDesignPrompt('');
    setDesignPreviews([]);
    setDesignError(null);
    setSelectedDesignIdx(null);
    setPlayingDesignIdx(null);
    if (designAudioRef.current) {
      designAudioRef.current.pause();
      designAudioRef.current = null;
    }
  };

  const handleDesignVoice = useCallback(async () => {
    if (!designPrompt.trim() || isDesigning) return;
    setIsDesigning(true);
    setDesignError(null);
    setDesignPreviews([]);
    setSelectedDesignIdx(null);
    try {
      const result = await designVoice(designPrompt.trim());
      setDesignPreviews(result.previews);
    } catch (err) {
      setDesignError(err instanceof Error ? err.message : 'Failed to generate voices');
    } finally {
      setIsDesigning(false);
    }
  }, [designPrompt, isDesigning]);

  const handlePlayDesignPreview = useCallback((idx: number) => {
    if (designAudioRef.current) {
      designAudioRef.current.pause();
      designAudioRef.current = null;
    }
    if (playingDesignIdx === idx) {
      setPlayingDesignIdx(null);
      return;
    }
    const preview = designPreviews[idx];
    if (!preview) return;
    const audio = new Audio(`data:${preview.mediaType};base64,${preview.audioBase64}`);
    audio.onended = () => { setPlayingDesignIdx(null); designAudioRef.current = null; };
    audio.onerror = () => { setPlayingDesignIdx(null); designAudioRef.current = null; };
    audio.play().catch(() => setPlayingDesignIdx(null));
    designAudioRef.current = audio;
    setPlayingDesignIdx(idx);
  }, [designPreviews, playingDesignIdx]);

  const handleConfirmDesignVoice = useCallback(() => {
    if (selectedDesignIdx === null) return;
    const preview = designPreviews[selectedDesignIdx];
    if (!preview) return;
    // Convert base64 to data URL for audioSampleUrl
    const dataUrl = `data:${preview.mediaType || 'audio/mpeg'};base64,${preview.audioBase64}`;
    setCharacterForm(prev => ({
      ...prev,
      audioSampleUrl: dataUrl,
      name: prev.name || `AI Voice ${selectedDesignIdx + 1}`,
      description: designPrompt.trim(),
      tags: prev.tags || 'ai-generated',
    }));
    setAudioUploaded(true);
  }, [selectedDesignIdx, designPreviews, designPrompt]);

  const togglePreviewAudio = () => {
    if (previewAudioRef.current) {
      if (isPlayingPreview) {
        previewAudioRef.current.pause();
        setIsPlayingPreview(false);
      } else {
        previewAudioRef.current.src = characterForm.audioSampleUrl;
        previewAudioRef.current.play();
        setIsPlayingPreview(true);
      }
    }
  };

  const saveCharacter = () => {
    const now = new Date().toISOString();
    const tagsArray = characterForm.tags.split(',').map(tag => tag.trim()).filter(Boolean);
    
    // audioSampleUrl is now a base64 data URL (from handleAudioUpload)
    // Set both audioSampleUrl (for playback) and refAudioDataUrl (for TTS voice cloning)
    const audioUrl = characterForm.audioSampleUrl || undefined;
    
    if (editingCharacter) {
      // Update existing character
      const updated = characters.map(c => 
        c.id === editingCharacter.id 
          ? { 
              ...c, 
              name: characterForm.name,
              description: characterForm.description,
              tags: tagsArray,
              audioSampleUrl: audioUrl,
              refAudioDataUrl: audioUrl,  // Also set refAudioDataUrl for TTS
              projectIds: characterForm.projectIds,
              updatedAt: now,
            }
          : c
      );
      setCharacters(updated);
      saveVoiceCharacters(updated);
    } else {
      // Create new character
      const newCharacter: VoiceCharacter = {
        id: crypto.randomUUID(),
        name: characterForm.name,
        description: characterForm.description,
        tags: tagsArray,
        audioSampleUrl: audioUrl,
        refAudioDataUrl: audioUrl,  // Also set refAudioDataUrl for TTS
        projectIds: characterForm.projectIds,
        createdAt: now,
        updatedAt: now,
      };
      const updated = [...characters, newCharacter];
      setCharacters(updated);
      saveVoiceCharacters(updated);
    }
    
    setShowCharacterEditor(false);
    setAudioUploaded(false);
  };
  
  // Filter characters by project
  const filteredCharacters = filterProjectId 
    ? characters.filter(c => c.projectIds?.includes(filterProjectId))
    : characters;

  const deleteCharacter = async (id: string) => {
    if (confirm(t.voiceStudio.characters.deleteConfirm)) {
      const updated = characters.filter(c => c.id !== id);
      setCharacters(updated);
      saveVoiceCharacters(updated);
      
      // Also delete from cloud storage (async, non-blocking)
      deleteVoiceCharacterFromCloud(id).catch(err => {
        console.error('Failed to delete voice from cloud:', err);
      });
    }
  };

  const playCharacterSample = (character: VoiceCharacter) => {
    const audioUrl = character.refAudioDataUrl || character.audioSampleUrl;
    if (audioUrl) {
      if (playingCharacterId === character.id) {
        characterAudioRef.current?.pause();
        setPlayingCharacterId(null);
      } else {
        if (characterAudioRef.current) {
          characterAudioRef.current.src = audioUrl;
          characterAudioRef.current.play();
          setPlayingCharacterId(character.id);
        }
      }
    }
  };


  return (
    <div className="space-y-4 md:space-y-8 animate-fade-in">
      {/* Header */}
      <div>
        <h1 className="text-xl sm:text-2xl md:text-3xl font-serif font-light text-t-text1 tracking-wide">{t.voiceStudio.title}</h1>
        <p className="text-t-text3 mt-1 text-sm md:text-base">{t.voiceStudio.subtitle}</p>
      </div>

      {/* Tabs */}
      <div className="flex gap-2 p-1 rounded-xl bg-t-card w-fit">
        <button
          onClick={() => setActiveTab('record')}
          className={`px-4 py-2 rounded-lg text-sm font-medium transition-all duration-300 flex items-center gap-2 ${
            activeTab === 'record' 
              ? 'text-t-text1' 
              : 'text-t-text3 hover:text-t-text2'
          }`}
          style={activeTab === 'record' ? { background: 'var(--t-bg-card)', boxShadow: `0 0 20px ${theme.glow}` } : {}}
        >
          <Mic size={16} />
          {t.voiceStudio.tabs.record}
        </button>
        <button
          onClick={() => setActiveTab('characters')}
          className={`px-4 py-2 rounded-lg text-sm font-medium transition-all duration-300 flex items-center gap-2 ${
            activeTab === 'characters' 
              ? 'text-t-text1' 
              : 'text-t-text3 hover:text-t-text2'
          }`}
          style={activeTab === 'characters' ? { background: 'var(--t-bg-card)', boxShadow: `0 0 20px ${theme.glow}` } : {}}
        >
          <AudioWaveform size={16} />
          {t.voiceStudio.tabs.characters}
        </button>
      </div>

      {/* Record Tab */}
      {activeTab === 'record' && (
        <>
          {/* Recording Interface */}
          <div className="rounded-xl md:rounded-2xl p-4 sm:p-6 lg:p-12 border border-t-border relative overflow-hidden" style={{ background: 'var(--t-bg-card)' }}>
            {/* Ambient glow */}
            <div className="absolute inset-0 pointer-events-none">
              <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[200px] md:w-[400px] h-[200px] md:h-[400px] rounded-full blur-[60px] md:blur-[100px] opacity-20" style={{ background: isRecording ? theme.primary : 'transparent' }} />
            </div>

            {/* Timer Display */}
            <div className="text-center mb-6 md:mb-12 relative">
              <div className="text-4xl sm:text-5xl md:text-7xl font-mono font-light tracking-wider text-t-text1">
                {formatTime(duration)}
              </div>
              <p className="text-t-text3 mt-2 md:mt-4 text-xs md:text-sm tracking-widest uppercase">{getStatusText()}</p>
            </div>

            {/* Waveform */}
            <div className="h-14 md:h-20 rounded-xl md:rounded-2xl mb-6 md:mb-12 flex items-center justify-center overflow-hidden" style={{ background: `${theme.primary}10` }}>
              {isRecording && !isPaused ? (
                <div className="flex items-end gap-0.5 md:gap-1 h-10 md:h-12">
                  {[...Array(20)].map((_, i) => (
                    <div
                      key={i}
                      className="w-1 md:w-1 rounded-full animate-pulse"
                      style={{ backgroundColor: theme.primaryLight, height: `${20 + Math.random() * 80}%`, animationDelay: `${i * 30}ms` }}
                    />
                  ))}
                </div>
              ) : (
                <div className="flex items-center gap-0.5 md:gap-1 h-10 md:h-12">
                  {[...Array(20)].map((_, i) => (
                    <div key={i} className="w-1 md:w-1 rounded-full" style={{ backgroundColor: theme.primary, opacity: 0.2, height: '20%' }} />
                  ))}
                </div>
              )}
            </div>

            {/* Controls */}
            <div className="flex items-center justify-center gap-4 md:gap-6 relative">
              {!isRecording && !audioUrl && (
                <button
                  onClick={startRecording}
                  className="w-20 h-20 md:w-24 md:h-24 rounded-full flex items-center justify-center text-t-text1 transition-all duration-300 hover:scale-110 active:scale-95"
                  style={{ background: theme.primary, boxShadow: `0 0 40px ${theme.glow}` }}
                >
                  <Mic size={28} className="md:hidden" />
                  <Mic size={36} className="hidden md:block" />
                </button>
              )}

              {isRecording && (
                <>
                  <button onClick={togglePause} className="w-12 h-12 md:w-16 md:h-16 rounded-full flex items-center justify-center text-t-text1 transition-all hover:scale-110 active:scale-95" style={{ background: `${theme.primary}80` }}>
                    {isPaused ? <Play size={20} className="md:hidden" /> : <Pause size={20} className="md:hidden" />}
                    {isPaused ? <Play size={24} className="hidden md:block" /> : <Pause size={24} className="hidden md:block" />}
                  </button>
                  <button onClick={stopRecording} className="w-20 h-20 md:w-24 md:h-24 rounded-full flex items-center justify-center text-t-text1 bg-red-500 transition-all hover:scale-110 active:scale-95" style={{ boxShadow: '0 0 40px rgba(239, 68, 68, 0.4)' }}>
                    <Square size={28} className="md:hidden" />
                    <Square size={36} className="hidden md:block" />
                  </button>
                </>
              )}

              {audioUrl && !isRecording && (
                <>
                  <button onClick={clearRecording} className="w-11 h-11 md:w-14 md:h-14 rounded-full flex items-center justify-center text-t-text1 bg-t-card-hover hover:bg-t-surface-m transition-all hover:scale-110 active:scale-95">
                    <Trash2 size={18} className="md:hidden" />
                    <Trash2 size={20} className="hidden md:block" />
                  </button>
                  <button
                    onClick={() => { if (audioRef.current) audioRef.current.paused ? audioRef.current.play() : audioRef.current.pause(); }}
                    className="w-20 h-20 md:w-24 md:h-24 rounded-full flex items-center justify-center text-t-text1 transition-all hover:scale-110 active:scale-95"
                    style={{ background: theme.primary, boxShadow: `0 0 40px ${theme.glow}` }}
                  >
                    <Play size={28} className="md:hidden" />
                    <Play size={36} className="hidden md:block" />
                  </button>
                  <button onClick={downloadRecording} className="w-11 h-11 md:w-14 md:h-14 rounded-full flex items-center justify-center transition-all hover:scale-110 active:scale-95" style={{ background: theme.accent, color: theme.primaryDark }}>
                    <Download size={18} className="md:hidden" />
                    <Download size={20} className="hidden md:block" />
                  </button>
                </>
              )}
            </div>

            {audioUrl && (
              <div className="mt-6 md:mt-8">
                <audio ref={audioRef} src={audioUrl} controls className="w-full opacity-70" />
              </div>
            )}
          </div>

          {/* Tips */}
          <div className="rounded-xl md:rounded-2xl p-4 md:p-6 border border-t-border" style={{ background: `${theme.primary}10` }}>
            <h3 className="font-serif text-t-text1 mb-2 md:mb-3 text-sm md:text-base">💡 {t.voiceStudio.tips.title}</h3>
            <ul className="space-y-1.5 md:space-y-2 text-xs md:text-sm text-t-text2">
              {t.voiceStudio.tips.list.map((tip, i) => (<li key={i}>• {tip}</li>))}
            </ul>
          </div>
        </>
      )}

      {/* Characters Tab */}
      {activeTab === 'characters' && (
        <>
          {/* Characters Header */}
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
            <div>
              <h2 className="text-lg md:text-xl font-serif text-t-text1">{t.voiceStudio.characters.title}</h2>
              <p className="text-t-text3 text-sm">{t.voiceStudio.characters.subtitle}</p>
            </div>
            <div className="flex items-center gap-2">
              {/* Project filter */}
              <div className="relative">
                <FolderOpen size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-t-text3" />
                <select
                  value={filterProjectId}
                  onChange={(e) => setFilterProjectId(e.target.value)}
                  className="pl-9 pr-8 py-2 rounded-lg bg-t-card border border-t-border text-t-text1 text-sm focus:outline-none focus:border-t-border appearance-none cursor-pointer"
                >
                  <option value="" className="bg-gray-900">{t.voiceStudio?.allProjects || 'All Projects'}</option>
                  {projects.map(p => (
                    <option key={p.id} value={p.id} className="bg-gray-900">{p.title}</option>
                  ))}
                </select>
              </div>
              <button
                onClick={() => openCharacterEditor()}
                className="flex items-center gap-2 px-4 py-2 rounded-xl text-t-text1 text-sm font-medium transition-all duration-300 hover:scale-105"
                style={{ background: theme.primary, boxShadow: `0 0 20px ${theme.glow}` }}
              >
                <Plus size={16} />
                {t.voiceStudio.characters.addNew}
              </button>
            </div>
          </div>

          {/* Characters Grid */}
          {filteredCharacters.length === 0 ? (
            <div className="rounded-xl md:rounded-2xl p-8 md:p-12 border border-t-border text-center" style={{ background: 'var(--t-bg-card)' }}>
              <div className="w-16 h-16 mx-auto mb-4 rounded-full flex items-center justify-center" style={{ background: `${theme.primary}20` }}>
                <User size={32} className="text-t-text3" />
              </div>
              <h3 className="text-t-text1 font-serif mb-2">{t.voiceStudio.characters.noCharacters}</h3>
              <p className="text-t-text3 text-sm mb-6">{t.voiceStudio.characters.createFirst}</p>
              <button
                onClick={() => openCharacterEditor()}
                className="px-6 py-3 rounded-xl text-t-text1 text-sm font-medium transition-all duration-300 hover:scale-105"
                style={{ background: theme.primary }}
              >
                <Plus size={16} className="inline mr-2" />
                {t.voiceStudio.characters.addNew}
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {filteredCharacters.map((character) => (
                <div
                  key={character.id}
                  className="rounded-xl p-4 border border-t-border transition-all duration-300 hover:border-t-border"
                  style={{ background: 'var(--t-bg-card)' }}
                >
                  <div className="flex items-start gap-3">
                    <div 
                      className="w-12 h-12 rounded-xl flex items-center justify-center flex-shrink-0"
                      style={{ background: `${theme.primary}20` }}
                    >
                      {character.avatarUrl ? (
                        <img src={character.avatarUrl} alt={character.name} className="w-full h-full rounded-xl object-cover" />
                      ) : (
                        <User size={24} style={{ color: theme.primaryLight }} />
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <h3 className="text-t-text1 font-medium truncate">{character.name}</h3>
                      <p className="text-t-text3 text-sm line-clamp-2">{character.description}</p>
                    </div>
                  </div>
                  
                  {character.tags.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-3">
                      {character.tags.slice(0, 3).map((tag, i) => (
                        <span key={i} className="px-2 py-0.5 rounded-full text-xs" style={{ background: `${theme.primary}20`, color: theme.primaryLight }}>
                          {tag}
                        </span>
                      ))}
                      {character.tags.length > 3 && (
                        <span className="px-2 py-0.5 rounded-full text-xs text-t-text3">+{character.tags.length - 3}</span>
                      )}
                    </div>
                  )}


                  {/* Linked projects */}
                  {character.projectIds && character.projectIds.length > 0 && (
                    <div className="flex items-center gap-1 mt-2 text-xs text-t-text3">
                      <Link2 size={12} />
                      {character.projectIds.slice(0, 2).map((pid, i) => {
                        const proj = projects.find(p => p.id === pid);
                        return proj ? (
                          <span key={pid}>
                            {i > 0 && ', '}
                            <span className="truncate max-w-[80px] inline-block align-bottom">{proj.title}</span>
                          </span>
                        ) : null;
                      })}
                      {character.projectIds.length > 2 && <span>+{character.projectIds.length - 2}</span>}
                    </div>
                  )}

                  <div className="flex items-center gap-2 mt-4 pt-3 border-t border-t-border-lt">
                    {(character.refAudioDataUrl || character.audioSampleUrl) && (
                      <button
                        onClick={() => playCharacterSample(character)}
                        className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-medium transition-all hover:scale-105"
                        style={{ background: `${theme.primary}20`, color: theme.primaryLight }}
                      >
                        {playingCharacterId === character.id ? <Pause size={12} /> : <Volume2 size={12} />}
                        {t.voiceStudio.characters.playSample}
                      </button>
                    )}
                    <div className="flex-1" />
                    <button
                      onClick={() => openCharacterEditor(character)}
                      className="p-2 rounded-lg text-t-text3 hover:text-t-text1 hover:bg-t-card-hover transition-all"
                    >
                      <Edit2 size={14} />
                    </button>
                    <button
                      onClick={() => deleteCharacter(character.id)}
                      className="p-2 rounded-lg text-t-text3 hover:text-red-400 hover:bg-red-500/10 transition-all"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Hidden audio element for character samples */}
          <audio 
            ref={characterAudioRef} 
            onEnded={() => setPlayingCharacterId(null)}
            className="hidden"
          />
        </>
      )}

      {/* Character Editor Modal */}
      {showCharacterEditor && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
          <div 
            className={`w-full rounded-2xl p-6 border border-t-border max-h-[90vh] overflow-y-auto ${
              !editingCharacter && !audioUploaded && !isAnalyzing ? 'max-w-2xl' : 'max-w-lg'
            }`}
            style={{ background: 'var(--t-bg-base)' }}
          >
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-xl font-serif text-t-text1">
                {editingCharacter ? t.voiceStudio.characters.edit : t.voiceStudio.characters.addNew}
              </h2>
              <button
                onClick={() => { setShowCharacterEditor(false); setAudioUploaded(false); resetDesignState(); }}
                className="p-2 rounded-lg text-t-text3 hover:text-t-text1 hover:bg-t-card-hover transition-all"
              >
                <X size={20} />
              </button>
            </div>

            {/* Step 1: AI Generate + Upload (for new characters only) */}
            {!editingCharacter && !audioUploaded && !isAnalyzing && (
              <div className="space-y-5">
                {/* Two-column: AI Generate (left) | Upload (right) */}
                <div className="grid grid-cols-2 gap-4">
                  {/* Left: AI Generate */}
                  <div className="rounded-xl border border-t-border p-4 space-y-3" style={{ background: 'var(--t-bg-card)' }}>
                    <div className="flex items-center gap-2 mb-1">
                      <Sparkles size={14} style={{ color: theme.primaryLight }} />
                      <span className="text-xs font-medium text-t-text2 uppercase tracking-wider">
                        {language === 'zh' ? 'AI 生成' : 'AI Generate'}
                      </span>
                    </div>
                    <textarea
                      value={designPrompt}
                      onChange={(e) => setDesignPrompt(e.target.value)}
                      placeholder={language === 'zh'
                        ? '描述你想要的声音...\n例如：一个温暖的中年男性声音，语速适中，带有磁性'
                        : 'Describe the voice...\ne.g. A warm middle-aged male voice, moderate pace'}
                      className="w-full px-3 py-2.5 rounded-lg border border-t-border bg-t-bg-base text-sm text-t-text1 placeholder-t-text3 focus:outline-none transition-all resize-none"
                      rows={3}
                    />
                    <button
                      onClick={handleDesignVoice}
                      disabled={!designPrompt.trim() || designPrompt.trim().length < 10 || isDesigning}
                      className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-all hover:scale-[1.02] disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:scale-100"
                      style={{ background: theme.primary, color: '#fff' }}
                    >
                      {isDesigning ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
                      {isDesigning
                        ? (language === 'zh' ? '生成中...' : 'Generating...')
                        : (language === 'zh' ? '生成 3 个候选' : 'Generate 3 Candidates')
                      }
                    </button>
                  </div>

                  {/* Right: Upload */}
                  <div className="rounded-xl border border-t-border p-4 space-y-3" style={{ background: 'var(--t-bg-card)' }}>
                    <div className="flex items-center gap-2 mb-1">
                      <Upload size={14} style={{ color: theme.primaryLight }} />
                      <span className="text-xs font-medium text-t-text2 uppercase tracking-wider">
                        {language === 'zh' ? '上传音频' : 'Upload Audio'}
                      </span>
                    </div>
                    <div
                      className="border-2 border-dashed rounded-lg p-5 text-center cursor-pointer border-t-border hover:border-t-border transition-all"
                      onClick={() => audioInputRef.current?.click()}
                      onDrop={handleDrop}
                      onDragOver={(e) => e.preventDefault()}
                    >
                      <div className="w-12 h-12 mx-auto mb-3 rounded-full flex items-center justify-center" style={{ background: `${theme.primary}20` }}>
                        <Upload size={20} style={{ color: theme.primaryLight }} />
                      </div>
                      <p className="text-xs text-t-text2 font-medium">
                        {language === 'zh' ? '点击或拖拽文件' : 'Click or drag file'}
                      </p>
                      <p className="text-[10px] text-t-text3 mt-1">MP3, WAV, M4A, OGG, FLAC · max 5 MB</p>
                    </div>
                    <input
                      ref={audioInputRef}
                      type="file"
                      accept="audio/*"
                      onChange={handleFileSelect}
                      className="hidden"
                    />
                  </div>
                </div>

                {/* Error */}
                {designError && (
                  <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400">
                    {designError}
                  </div>
                )}

                {/* Generated voice previews (full width) */}
                {designPreviews.length > 0 && (
                  <div className="space-y-3">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-medium text-t-text3 uppercase tracking-wider">
                        {language === 'zh' ? '候选音色' : 'Candidates'}
                      </span>
                      <div className="flex-1 h-px bg-t-border" />
                      <button
                        onClick={handleDesignVoice}
                        disabled={isDesigning}
                        className="flex items-center gap-1 text-xs text-t-text3 hover:text-t-text2 transition-colors disabled:opacity-50"
                      >
                        <RotateCcw size={12} className={isDesigning ? 'animate-spin' : ''} />
                        {language === 'zh' ? '重新生成' : 'Regenerate'}
                      </button>
                    </div>

                    <div className="grid grid-cols-3 gap-3">
                      {designPreviews.map((preview, idx) => {
                        const isPlaying = playingDesignIdx === idx;
                        const isSelected = selectedDesignIdx === idx;
                        return (
                          <div
                            key={preview.generatedVoiceId}
                            onClick={() => setSelectedDesignIdx(idx)}
                            className={`relative rounded-xl border p-3 transition-all cursor-pointer group text-center ${
                              isSelected ? 'border-2' : 'border-t-border hover:border-t-border'
                            }`}
                            style={isSelected ? { borderColor: theme.primary, background: `${theme.primary}08` } : { background: 'var(--t-bg-card)' }}
                          >
                            {isSelected && (
                              <div className="absolute top-1.5 right-1.5 w-4 h-4 rounded-full flex items-center justify-center" style={{ background: theme.primary }}>
                                <Check size={10} className="text-white" />
                              </div>
                            )}
                            <div
                              className="relative w-10 h-10 rounded-full flex items-center justify-center mx-auto mb-2"
                              style={{ background: `${theme.primary}20` }}
                              onClick={(e) => { e.stopPropagation(); handlePlayDesignPreview(idx); }}
                            >
                              <span className={`transition-opacity duration-150 ${isPlaying ? 'opacity-0' : 'group-hover:opacity-0'}`}>
                                <Sparkles size={16} style={{ color: theme.primaryLight }} />
                              </span>
                              <span
                                className={`absolute inset-0 flex items-center justify-center rounded-full transition-all duration-150 ${
                                  isPlaying ? 'opacity-100 scale-100' : 'opacity-0 scale-90 group-hover:opacity-100 group-hover:scale-100'
                                }`}
                                style={{ background: isPlaying ? theme.primary : `${theme.primary}40` }}
                              >
                                {isPlaying ? <Square size={10} className="text-white" /> : <Play size={14} className="ml-0.5 text-white" />}
                              </span>
                            </div>
                            <h4 className="text-xs font-medium text-t-text1">
                              {language === 'zh' ? `候选 ${idx + 1}` : `Voice ${idx + 1}`}
                            </h4>
                            <p className="text-[10px] text-t-text3 mt-0.5">
                              {preview.durationSecs > 0 ? `${preview.durationSecs.toFixed(1)}s` : ''} {preview.language || 'en'}
                            </p>
                          </div>
                        );
                      })}
                    </div>

                    {/* Confirm selected candidate */}
                    {selectedDesignIdx !== null && (
                      <button
                        onClick={handleConfirmDesignVoice}
                        className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium transition-all hover:scale-[1.02]"
                        style={{ background: theme.primary, color: '#fff' }}
                      >
                        <Check size={14} />
                        {language === 'zh' ? '使用此音色' : 'Use This Voice'}
                      </button>
                    )}
                  </div>
                )}

                {/* Cancel */}
                <div className="text-center">
                  <button
                    onClick={() => { setShowCharacterEditor(false); resetDesignState(); }}
                    className="px-6 py-2 text-t-text3 hover:text-t-text2 transition-all text-sm"
                  >
                    {t.voiceStudio.characters.cancel}
                  </button>
                </div>
              </div>
            )}

            {/* Analyzing State */}
            {isAnalyzing && (
              <div className="text-center py-8">
                <div 
                  className="w-16 h-16 mx-auto mb-4 rounded-full flex items-center justify-center animate-pulse"
                  style={{ background: `${theme.primary}30` }}
                >
                  <AudioWaveform size={28} style={{ color: theme.primaryLight }} />
                </div>
                <h3 className="text-t-text1 font-medium mb-2">{t.voiceStudio.characters.analyzing}</h3>
                <p className="text-t-text3 text-sm">{t.voiceStudio.characters.analyzingHint}</p>
              </div>
            )}

            {/* Step 2: Form (after upload or when editing) */}
            {(audioUploaded || editingCharacter) && !isAnalyzing && (
              <>
                <div className="space-y-4">
                  {/* Audio Sample Preview */}
                  {characterForm.audioSampleUrl && (
                    <div 
                      className="rounded-xl p-4 border border-t-border"
                      style={{ background: `${theme.primary}10` }}
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <button
                            onClick={togglePreviewAudio}
                            className="w-10 h-10 rounded-full flex items-center justify-center transition-all hover:scale-105"
                            style={{ background: theme.primary }}
                          >
                            {isPlayingPreview ? <Pause size={18} className="text-t-text1" /> : <Play size={18} className="text-t-text1 ml-0.5" />}
                          </button>
                          <div>
                            <p className="text-t-text1 text-sm font-medium">{t.voiceStudio.characters.audioSample}</p>
                            <p className="text-t-text3 text-xs">{t.voiceStudio.characters.analysisComplete}</p>
                          </div>
                        </div>
                        {!editingCharacter && (
                          <button
                            onClick={resetAudioUpload}
                            className="px-3 py-1.5 rounded-lg text-xs text-t-text3 hover:text-t-text1 hover:bg-t-card-hover transition-all"
                          >
                            {t.voiceStudio.characters.reupload}
                          </button>
                        )}
                      </div>
                      <audio 
                        ref={previewAudioRef} 
                        onEnded={() => setIsPlayingPreview(false)}
                        className="hidden"
                      />
                    </div>
                  )}

                  {/* Name */}
                  <div>
                    <label className="block text-sm font-medium text-t-text3 mb-2">{t.voiceStudio.characters.name}</label>
                    <input
                      type="text"
                      value={characterForm.name}
                      onChange={(e) => setCharacterForm({ ...characterForm, name: e.target.value })}
                      placeholder={t.voiceStudio.characters.namePlaceholder}
                      className="w-full px-4 py-3 rounded-xl border border-t-border bg-t-card text-t-text1 focus:outline-none focus:border-t-border"
                    />
                  </div>

                  {/* Description */}
                  <div>
                    <label className="block text-sm font-medium text-t-text3 mb-2">{t.voiceStudio.characters.description}</label>
                    <textarea
                      value={characterForm.description}
                      onChange={(e) => setCharacterForm({ ...characterForm, description: e.target.value })}
                      placeholder={t.voiceStudio.characters.descriptionPlaceholder}
                      rows={3}
                      className="w-full px-4 py-3 rounded-xl border border-t-border bg-t-card text-t-text1 focus:outline-none focus:border-t-border resize-none"
                    />
                  </div>

                  {/* Tags */}
                  <div>
                    <label className="block text-sm font-medium text-t-text3 mb-2">{t.voiceStudio.characters.tags}</label>
                    <input
                      type="text"
                      value={characterForm.tags}
                      onChange={(e) => setCharacterForm({ ...characterForm, tags: e.target.value })}
                      placeholder={t.voiceStudio.characters.tagsPlaceholder}
                      className="w-full px-4 py-3 rounded-xl border border-t-border bg-t-card text-t-text1 focus:outline-none focus:border-t-border"
                    />
                  </div>

                  {/* Avatar Upload */}
                  <div>
                    <label className="block text-sm font-medium text-t-text3 mb-2">{t.voiceStudio.characters.avatar}</label>
                    <button
                      className="w-full px-4 py-3 rounded-xl border border-dashed border-t-border text-t-text3 hover:border-t-border hover:text-t-text2 transition-all flex items-center justify-center gap-2"
                    >
                      <Upload size={16} />
                      {t.voiceStudio.characters.uploadAvatar}
                    </button>
                  </div>

                  {/* Linked Projects */}
                  <div>
                    <label className="block text-sm font-medium text-t-text3 mb-2">
                      <Link2 size={14} className="inline mr-1" />
                      {t.voiceStudio?.characters?.linkedProjects || 'Linked Projects'}
                    </label>
                    <div className="flex flex-wrap gap-2">
                      {projects.map(p => {
                        const isLinked = characterForm.projectIds.includes(p.id);
                        return (
                          <button
                            key={p.id}
                            type="button"
                            onClick={() => {
                              setCharacterForm(prev => ({
                                ...prev,
                                projectIds: isLinked 
                                  ? prev.projectIds.filter(id => id !== p.id)
                                  : [...prev.projectIds, p.id]
                              }));
                            }}
                            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                              isLinked 
                                ? 'text-t-text1' 
                                : 'text-t-text3 hover:text-t-text2 border border-t-border hover:border-t-border'
                            }`}
                            style={isLinked ? { background: theme.primary } : {}}
                          >
                            <FolderOpen size={12} className="inline mr-1" />
                            {p.title}
                          </button>
                        );
                      })}
                      {projects.length === 0 && (
                        <span className="text-t-text3 text-sm">{t.voiceStudio?.noProjects || 'No projects'}</span>
                      )}
                    </div>
                  </div>
                </div>

                {/* Actions */}
                <div className="flex gap-3 mt-6">
                  <button
                    onClick={() => { setShowCharacterEditor(false); setAudioUploaded(false); resetDesignState(); }}
                    className="flex-1 px-4 py-3 rounded-xl border border-t-border text-t-text2 hover:text-t-text1 hover:border-t-border transition-all"
                  >
                    {t.voiceStudio.characters.cancel}
                  </button>
                  <button
                    onClick={saveCharacter}
                    disabled={!characterForm.name.trim()}
                    className="flex-1 px-4 py-3 rounded-xl text-t-text1 font-medium transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                    style={{ background: theme.primary }}
                  >
                    {t.voiceStudio.characters.save}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
