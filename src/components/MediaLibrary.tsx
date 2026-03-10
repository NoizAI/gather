import { useState, useRef, useEffect } from 'react';
import { useTheme } from '../contexts/ThemeContext';
import { useLanguage } from '../i18n/LanguageContext';
import { useProjects } from '../contexts/ProjectContext';
import { MediaItem, MediaType } from '../types';
import { 
  loadMediaItems, 
  addMediaItem, 
  deleteMediaItem, 
  updateMediaItem,
  fileToDataUrl,
  getAudioDuration,
  formatFileSize,
  formatDuration,
  uploadMediaToCloud,
  deleteMediaFromCloud,
  loadMediaItemsFromCloudStorage
} from '../utils/mediaStorage';
import { 
  generateImage, 
  generateBGM, 
  generateSoundEffect,
  imageDataToUrl,
  audioDataToUrl
} from '../services/api';
import { 
  Image, 
  Music, 
  Sparkles, 
  Upload, 
  Trash2, 
  Play, 
  Pause, 
  Download,
  Edit2,
  X,
  Search,
  Grid,
  List,
  Loader2,
  Wand2,
  ImagePlus,
  Volume2,
  FolderOpen,
  Link2
} from 'lucide-react';

type ViewMode = 'grid' | 'list';

export function MediaLibrary() {
  const { theme } = useTheme();
  const { t } = useLanguage();
  const { projects } = useProjects();
  
  // State
  const [items, setItems] = useState<MediaItem[]>(() => loadMediaItems());
  const [, setIsLoadingFromCloud] = useState(false);
  const [activeTab, setActiveTab] = useState<MediaType>('image');
  const [viewMode, setViewMode] = useState<ViewMode>('grid');
  const [searchQuery, setSearchQuery] = useState('');
  
  // Load from cloud on mount
  useEffect(() => {
    const loadFromCloud = async () => {
      setIsLoadingFromCloud(true);
      try {
        const cloudItems = await loadMediaItemsFromCloudStorage();
        setItems(cloudItems);
      } catch (error) {
        console.error('Failed to load media from cloud:', error);
      } finally {
        setIsLoadingFromCloud(false);
      }
    };
    loadFromCloud();
  }, []);
  
  // Modal states
  const [showUploadModal, setShowUploadModal] = useState(false);
  const [showGenerateModal, setShowGenerateModal] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [editingItem, setEditingItem] = useState<MediaItem | null>(null);
  
  // Generation states
  const [isGenerating, setIsGenerating] = useState(false);
  const [generatePrompt, setGeneratePrompt] = useState('');
  const [generateType, setGenerateType] = useState<MediaType>('image');
  const [generateDuration, setGenerateDuration] = useState(10);
  
  // Playback states
  const [playingId, setPlayingId] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  
  // Upload form state
  const [uploadForm, setUploadForm] = useState({
    name: '',
    description: '',
    tags: '',
    type: 'image' as MediaType,
    projectIds: [] as string[]
  });
  
  // Project filter
  const [filterProjectId, setFilterProjectId] = useState<string>('');
  const [uploadedFile, setUploadedFile] = useState<{
    dataUrl: string;
    mimeType: string;
    size: number;
    originalName: string;
    duration?: number;
  } | null>(null);
  const [isDraggingUpload, setIsDraggingUpload] = useState(false);

  // Filter and search items
  const filteredItems = items.filter(item => {
    // Tab filter
    if (item.type !== activeTab) return false;
    
    // Project filter
    if (filterProjectId) {
      if (!item.projectIds?.includes(filterProjectId)) return false;
    }
    
    // Search filter
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      const matchesSearch = 
        item.name.toLowerCase().includes(query) ||
        item.description.toLowerCase().includes(query) ||
        item.tags.some(tag => tag.toLowerCase().includes(query));
      if (!matchesSearch) return false;
    }
    
    return true;
  });

  // Tab counts
  const imageCounts = items.filter(i => i.type === 'image').length;
  const bgmCounts = items.filter(i => i.type === 'bgm').length;
  const sfxCounts = items.filter(i => i.type === 'sfx').length;

  const tabs = [
    { id: 'image' as MediaType, label: t.mediaLibrary?.tabs?.images || 'Images', icon: Image, count: imageCounts },
    { id: 'bgm' as MediaType, label: t.mediaLibrary?.tabs?.bgm || 'BGM', icon: Music, count: bgmCounts },
    { id: 'sfx' as MediaType, label: t.mediaLibrary?.tabs?.sfx || 'Sound Effects', icon: Sparkles, count: sfxCounts },
  ];

  // Audio playback
  const togglePlay = (item: MediaItem) => {
    if (playingId === item.id) {
      audioRef.current?.pause();
      setPlayingId(null);
    } else {
      if (audioRef.current) {
        audioRef.current.src = item.dataUrl;
        audioRef.current.play();
        setPlayingId(item.id);
      }
    }
  };

  useEffect(() => {
    const audio = audioRef.current;
    if (audio) {
      const handleEnded = () => setPlayingId(null);
      audio.addEventListener('ended', handleEnded);
      return () => audio.removeEventListener('ended', handleEnded);
    }
  }, []);

  const processFile = async (file: File) => {
    if (!file) return;

    const dataUrl = await fileToDataUrl(file);
    const isAudio = file.type.startsWith('audio/');
    const isImage = file.type.startsWith('image/');
    
    let duration: number | undefined;
    if (isAudio) {
      duration = await getAudioDuration(dataUrl);
    }

    setUploadedFile({
      dataUrl,
      mimeType: file.type,
      size: file.size,
      originalName: file.name,
      duration
    });

    // Auto-detect type
    let detectedType: MediaType = 'image';
    if (isAudio) {
      detectedType = file.name.toLowerCase().includes('sfx') || 
                     file.name.toLowerCase().includes('effect') ? 'sfx' : 'bgm';
    }

    setUploadForm(prev => ({
      ...prev,
      name: file.name.replace(/\.[^/.]+$/, ''),
      type: isImage ? 'image' : detectedType,
      projectIds: []
    }));
    setShowUploadModal(true);
  };

  // File upload handler
  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    await processFile(file);
  };

  const handleDropUpload = async (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDraggingUpload(false);
    const file = e.dataTransfer.files?.[0];
    if (!file) return;
    await processFile(file);
  };

  const handleDragEnterUpload = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDraggingUpload(true);
  };

  const handleDragOverUpload = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    if (!isDraggingUpload) {
      setIsDraggingUpload(true);
    }
  };

  const handleDragLeaveUpload = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.currentTarget === e.target) {
      setIsDraggingUpload(false);
    }
  };

  // Save uploaded media
  const saveUploadedMedia = async () => {
    if (!uploadedFile || !uploadForm.name.trim()) return;

    // Generate a temp ID for cloud upload
    const tempId = `media-${Date.now()}`;
    
    // Try to upload to cloud first
    let finalDataUrl = uploadedFile.dataUrl;
    try {
      const cloudUrl = await uploadMediaToCloud(
        tempId,
        uploadedFile.dataUrl,
        uploadForm.type,
        uploadForm.name || uploadedFile.originalName
      );
      if (cloudUrl && cloudUrl !== uploadedFile.dataUrl) {
        finalDataUrl = cloudUrl;
        console.log(`Uploaded media to cloud: ${cloudUrl}`);
      }
    } catch (error) {
      console.error('Failed to upload media to cloud, using local storage:', error);
    }

    const newItem: Omit<MediaItem, 'id' | 'createdAt' | 'updatedAt'> = {
      name: uploadForm.name,
      description: uploadForm.description,
      type: uploadForm.type,
      mimeType: uploadedFile.mimeType,
      dataUrl: finalDataUrl,
      size: uploadedFile.size,
      duration: uploadedFile.duration,
      tags: uploadForm.tags.split(',').map(t => t.trim()).filter(Boolean),
      projectIds: uploadForm.projectIds,
      source: 'uploaded'
    };

    const updated = addMediaItem(items, newItem);
    setItems(updated);
    setActiveTab(uploadForm.type);
    closeUploadModal();
  };

  const closeUploadModal = () => {
    setShowUploadModal(false);
    setUploadedFile(null);
    setUploadForm({ name: '', description: '', tags: '', type: 'image', projectIds: [] });
  };

  // Generate media
  const handleGenerate = async () => {
    if (!generatePrompt.trim()) return;
    
    setIsGenerating(true);
    try {
      let newItem: Omit<MediaItem, 'id' | 'createdAt' | 'updatedAt'>;
      const tempId = `media-${Date.now()}`;

      if (generateType === 'image') {
        const images = await generateImage(generatePrompt, { aspectRatio: '1:1' });
        if (images.length > 0) {
          const img = images[0];
          let dataUrl = imageDataToUrl(img.imageData, img.mimeType);
          
          // Upload to cloud
          try {
            const cloudUrl = await uploadMediaToCloud(tempId, dataUrl, 'image');
            if (cloudUrl && cloudUrl !== dataUrl) {
              dataUrl = cloudUrl;
              console.log(`Uploaded generated image to cloud: ${cloudUrl}`);
            }
          } catch (error) {
            console.error('Failed to upload generated image to cloud:', error);
          }
          
          newItem = {
            name: generatePrompt.slice(0, 50),
            description: generatePrompt,
            type: 'image',
            mimeType: img.mimeType,
            dataUrl,
            tags: ['generated', 'ai'],
            projectIds: [],
            source: 'generated',
            prompt: generatePrompt
          };
        } else {
          throw new Error('No image generated');
        }
      } else if (generateType === 'bgm') {
        const result = await generateBGM(generatePrompt, undefined, generateDuration);
        let dataUrl = audioDataToUrl(result.audioData, result.mimeType);
        
        // Upload to cloud
        try {
          const cloudUrl = await uploadMediaToCloud(tempId, dataUrl, 'bgm');
          if (cloudUrl && cloudUrl !== dataUrl) {
            dataUrl = cloudUrl;
            console.log(`Uploaded generated BGM to cloud: ${cloudUrl}`);
          }
        } catch (error) {
          console.error('Failed to upload generated BGM to cloud:', error);
        }
        
        newItem = {
          name: generatePrompt.slice(0, 50),
          description: generatePrompt,
          type: 'bgm',
          mimeType: result.mimeType,
          dataUrl,
          duration: generateDuration,
          tags: ['generated', 'ai', 'bgm'],
          projectIds: [],
          source: 'generated',
          prompt: generatePrompt
        };
      } else {
        const result = await generateSoundEffect(generatePrompt, generateDuration);
        let dataUrl = audioDataToUrl(result.audioData, result.mimeType);
        
        // Upload to cloud
        try {
          const cloudUrl = await uploadMediaToCloud(tempId, dataUrl, 'sfx');
          if (cloudUrl && cloudUrl !== dataUrl) {
            dataUrl = cloudUrl;
            console.log(`Uploaded generated SFX to cloud: ${cloudUrl}`);
          }
        } catch (error) {
          console.error('Failed to upload generated SFX to cloud:', error);
        }
        
        newItem = {
          name: generatePrompt.slice(0, 50),
          description: generatePrompt,
          type: 'sfx',
          mimeType: result.mimeType,
          dataUrl,
          duration: generateDuration,
          tags: ['generated', 'ai', 'sfx'],
          projectIds: [],
          source: 'generated',
          prompt: generatePrompt
        };
      }

      const updated = addMediaItem(items, newItem);
      setItems(updated);
      setActiveTab(generateType);
      closeGenerateModal();
    } catch (error) {
      console.error('Generation failed:', error);
      alert((t.mediaLibrary?.errors?.generationFailed || 'Generation failed: ') + (error as Error).message);
    } finally {
      setIsGenerating(false);
    }
  };

  const closeGenerateModal = () => {
    setShowGenerateModal(false);
    setGeneratePrompt('');
    setGenerateDuration(10);
  };

  // Delete media
  const handleDelete = async (id: string) => {
    if (confirm(t.mediaLibrary?.deleteConfirm || 'Delete this media item?')) {
      // Find the item to get its type and URL for cloud deletion
      const itemToDelete = items.find(item => item.id === id);
      
      const updated = deleteMediaItem(items, id);
      setItems(updated);
      
      if (playingId === id) {
        audioRef.current?.pause();
        setPlayingId(null);
      }
      
      // Also try to delete from cloud
      if (itemToDelete) {
        try {
          await deleteMediaFromCloud(id, itemToDelete.type, itemToDelete.dataUrl);
        } catch (error) {
          console.error('Failed to delete media from cloud:', error);
        }
      }
    }
  };

  // Edit media
  const openEditModal = (item: MediaItem) => {
    setEditingItem(item);
    setShowEditModal(true);
  };

  const saveEditedMedia = () => {
    if (!editingItem) return;
    const updated = updateMediaItem(items, editingItem.id, editingItem);
    setItems(updated);
    setShowEditModal(false);
    setEditingItem(null);
  };

  // Download media
  const handleDownload = (item: MediaItem) => {
    const a = document.createElement('a');
    a.href = item.dataUrl;
    const ext = item.mimeType.split('/')[1] || (item.type === 'image' ? 'png' : 'mp3');
    a.download = `${item.name}.${ext}`;
    a.click();
  };

  return (
    <div
      className="space-y-4 md:space-y-8 animate-fade-in"
      onDragEnter={handleDragEnterUpload}
      onDragOver={handleDragOverUpload}
      onDragLeave={handleDragLeaveUpload}
      onDrop={handleDropUpload}
    >
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-xl sm:text-2xl md:text-3xl font-serif font-light text-t-text1 tracking-wide">
            {t.mediaLibrary?.title || 'Media Library'}
          </h1>
          <p className="text-t-text3 mt-1 text-sm md:text-base">
            {t.mediaLibrary?.subtitle || 'Manage your images, music, and sound effects'}
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => fileInputRef.current?.click()}
            className="flex items-center gap-2 px-4 py-2 rounded-xl bg-t-card-hover text-t-text1 text-sm font-medium transition-all duration-300 hover:bg-t-surface-m"
          >
            <Upload size={16} />
            {t.mediaLibrary?.upload || 'Upload'}
          </button>
          <button
            onClick={() => { setGenerateType(activeTab); setShowGenerateModal(true); }}
            className="flex items-center gap-2 px-4 py-2 rounded-xl text-t-text1 text-sm font-medium transition-all duration-300 hover:scale-105"
            style={{ background: theme.primary, boxShadow: `0 0 20px ${theme.glow}` }}
          >
            <Wand2 size={16} />
            {t.mediaLibrary?.generate || 'Generate'}
          </button>
        </div>
      </div>

      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*,audio/*"
        onChange={handleFileSelect}
        className="hidden"
      />

      {isDraggingUpload && (
        <div
          className="fixed inset-0 z-40 pointer-events-none flex items-center justify-center"
          style={{ background: 'rgba(0, 0, 0, 0.35)' }}
        >
          <div
            className="rounded-2xl px-6 py-5 border border-t-border text-center"
            style={{ background: 'var(--t-bg-base)' }}
          >
            <Upload size={24} className="mx-auto mb-2" style={{ color: theme.primaryLight }} />
            <p className="text-t-text1 text-sm font-medium">
              {t.mediaLibrary?.dropToUpload || 'Drop file to upload'}
            </p>
            <p className="text-t-text3 text-xs mt-1">
              {t.mediaLibrary?.dropHint || 'Supports image and audio files'}
            </p>
          </div>
        </div>
      )}

      {/* Tabs */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div className="flex gap-2 p-1 rounded-xl bg-t-card w-fit">
          {tabs.map(tab => {
            const Icon = tab.icon;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`px-4 py-2 rounded-lg text-sm font-medium transition-all duration-300 flex items-center gap-2 ${
                  activeTab === tab.id 
                    ? 'text-t-text1' 
                    : 'text-t-text3 hover:text-t-text2'
                }`}
                style={activeTab === tab.id ? { background: 'var(--t-bg-card)', boxShadow: `0 0 20px ${theme.glow}` } : {}}
              >
                <Icon size={16} />
                {tab.label}
                {tab.count > 0 && (
                  <span className="px-1.5 py-0.5 rounded-full text-xs bg-t-card-hover">
                    {tab.count}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* Search and view controls */}
        <div className="flex items-center gap-2 flex-wrap">
          {/* Project filter */}
          <div className="relative">
            <FolderOpen size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-t-text3" />
            <select
              value={filterProjectId}
              onChange={(e) => setFilterProjectId(e.target.value)}
              className="pl-9 pr-8 py-2 rounded-lg bg-t-card border border-t-border text-t-text1 text-sm focus:outline-none focus:border-t-border appearance-none cursor-pointer"
            >
              <option value="" className="bg-gray-900">{t.mediaLibrary?.allProjects || 'All Projects'}</option>
              {projects.map(p => (
                <option key={p.id} value={p.id} className="bg-gray-900">{p.title}</option>
              ))}
            </select>
          </div>
          <div className="relative">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-t-text3" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={t.mediaLibrary?.searchPlaceholder || 'Search...'}
              className="pl-9 pr-4 py-2 rounded-lg bg-t-card border border-t-border text-t-text1 text-sm focus:outline-none focus:border-t-border w-48"
            />
          </div>
          <div className="flex gap-1 p-1 rounded-lg bg-t-card">
            <button
              onClick={() => setViewMode('grid')}
              className={`p-2 rounded-md transition-all ${viewMode === 'grid' ? 'bg-t-card-hover text-t-text1' : 'text-t-text3 hover:text-t-text2'}`}
            >
              <Grid size={16} />
            </button>
            <button
              onClick={() => setViewMode('list')}
              className={`p-2 rounded-md transition-all ${viewMode === 'list' ? 'bg-t-card-hover text-t-text1' : 'text-t-text3 hover:text-t-text2'}`}
            >
              <List size={16} />
            </button>
          </div>
        </div>
      </div>

      {/* Content */}
      {filteredItems.length === 0 ? (
        <div className="rounded-xl md:rounded-2xl p-8 md:p-12 border border-t-border text-center" style={{ background: 'var(--t-bg-card)' }}>
          <div className="w-16 h-16 mx-auto mb-4 rounded-full flex items-center justify-center" style={{ background: `${theme.primary}20` }}>
            {activeTab === 'image' ? <Image size={32} className="text-t-text3" /> :
             activeTab === 'bgm' ? <Music size={32} className="text-t-text3" /> :
             <Sparkles size={32} className="text-t-text3" />}
          </div>
          <h3 className="text-t-text1 font-serif mb-2">
            {t.mediaLibrary?.empty?.title || 'No media yet'}
          </h3>
          <p className="text-t-text3 text-sm mb-6">
            {t.mediaLibrary?.empty?.description || 'Upload or generate your first media'}
          </p>
          <div className="flex justify-center gap-3">
            <button
              onClick={() => fileInputRef.current?.click()}
              className="px-4 py-2 rounded-xl bg-t-card-hover text-t-text1 text-sm font-medium transition-all hover:bg-t-surface-m"
            >
              <Upload size={16} className="inline mr-2" />
              {t.mediaLibrary?.upload || 'Upload'}
            </button>
            <button
              onClick={() => { setGenerateType(activeTab); setShowGenerateModal(true); }}
              className="px-4 py-2 rounded-xl text-t-text1 text-sm font-medium transition-all hover:scale-105"
              style={{ background: theme.primary }}
            >
              <Wand2 size={16} className="inline mr-2" />
              {t.mediaLibrary?.generate || 'Generate'}
            </button>
          </div>
        </div>
      ) : viewMode === 'grid' ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
          {filteredItems.map(item => (
            <div
              key={item.id}
              className="group rounded-xl border border-t-border overflow-hidden transition-all duration-300 hover:border-t-border"
              style={{ background: 'var(--t-bg-card)' }}
            >
              {/* Preview */}
              <div className="aspect-square relative">
                {item.type === 'image' ? (
                  <img 
                    src={item.dataUrl} 
                    alt={item.name}
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <div 
                    className="w-full h-full flex items-center justify-center"
                    style={{ background: `${theme.primary}10` }}
                  >
                    {item.type === 'bgm' ? (
                      <Music size={48} style={{ color: theme.primaryLight }} />
                    ) : (
                      <Sparkles size={48} style={{ color: theme.primaryLight }} />
                    )}
                  </div>
                )}
                
                {/* Hover overlay */}
                <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-2">
                  {(item.type === 'bgm' || item.type === 'sfx') && (
                    <button
                      onClick={() => togglePlay(item)}
                      className="w-10 h-10 rounded-full flex items-center justify-center text-t-text1 transition-all hover:scale-110"
                      style={{ background: theme.primary }}
                    >
                      {playingId === item.id ? <Pause size={18} /> : <Play size={18} className="ml-0.5" />}
                    </button>
                  )}
                  <button
                    onClick={() => handleDownload(item)}
                    className="w-10 h-10 rounded-full flex items-center justify-center bg-t-surface-m text-t-text1 transition-all hover:bg-t-card"
                  >
                    <Download size={18} />
                  </button>
                  <button
                    onClick={() => handleDelete(item.id)}
                    className="w-10 h-10 rounded-full flex items-center justify-center bg-red-500/20 text-red-400 transition-all hover:bg-red-500/30"
                  >
                    <Trash2 size={18} />
                  </button>
                </div>

                {/* Duration badge */}
                {item.duration && (
                  <div className="absolute bottom-2 right-2 px-2 py-0.5 rounded-full bg-black/60 text-t-text1 text-xs">
                    {formatDuration(item.duration)}
                  </div>
                )}

                {/* Generated badge */}
                {item.source === 'generated' && (
                  <div className="absolute top-2 left-2 px-2 py-0.5 rounded-full text-xs flex items-center gap-1" style={{ background: `${theme.primary}80`, color: 'white' }}>
                    <Wand2 size={10} />
                    AI
                  </div>
                )}
              </div>

              {/* Info */}
              <div className="p-3">
                <h4 className="text-t-text1 text-sm font-medium truncate">{item.name}</h4>
                <p className="text-t-text3 text-xs mt-1 truncate">{item.description || '-'}</p>
                {item.tags.length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-2">
                    {item.tags.slice(0, 2).map((tag, i) => (
                      <span key={i} className="px-1.5 py-0.5 rounded-full text-[10px]" style={{ background: `${theme.primary}20`, color: theme.primaryLight }}>
                        {tag}
                      </span>
                    ))}
                  </div>
                )}
                {/* Linked projects */}
                {item.projectIds && item.projectIds.length > 0 && (
                  <div className="flex items-center gap-1 mt-2 text-[10px] text-t-text3">
                    <Link2 size={10} />
                    {item.projectIds.slice(0, 2).map(pid => {
                      const proj = projects.find(p => p.id === pid);
                      return proj ? <span key={pid} className="truncate max-w-[60px]">{proj.title}</span> : null;
                    }).filter(Boolean).reduce((acc, el, i) => i === 0 ? [el] : [...acc, ', ', el], [] as React.ReactNode[])}
                    {item.projectIds.length > 2 && <span>+{item.projectIds.length - 2}</span>}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="space-y-2">
          {filteredItems.map(item => (
            <div
              key={item.id}
              className="flex items-center gap-4 p-4 rounded-xl border border-t-border transition-all duration-300 hover:border-t-border"
              style={{ background: 'var(--t-bg-card)' }}
            >
              {/* Thumbnail */}
              <div className="w-16 h-16 rounded-lg overflow-hidden flex-shrink-0">
                {item.type === 'image' ? (
                  <img src={item.dataUrl} alt={item.name} className="w-full h-full object-cover" />
                ) : (
                  <div className="w-full h-full flex items-center justify-center" style={{ background: `${theme.primary}20` }}>
                    {item.type === 'bgm' ? <Music size={24} style={{ color: theme.primaryLight }} /> : <Sparkles size={24} style={{ color: theme.primaryLight }} />}
                  </div>
                )}
              </div>

              {/* Info */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <h4 className="text-t-text1 font-medium truncate">{item.name}</h4>
                  {item.source === 'generated' && (
                    <span className="px-1.5 py-0.5 rounded-full text-[10px] flex items-center gap-1" style={{ background: `${theme.primary}40`, color: theme.primaryLight }}>
                      <Wand2 size={10} />
                      AI
                    </span>
                  )}
                </div>
                <p className="text-t-text3 text-sm truncate">{item.description || '-'}</p>
                <div className="flex items-center gap-3 mt-1 text-xs text-t-text3">
                  {item.duration && <span>{formatDuration(item.duration)}</span>}
                  {item.size && <span>{formatFileSize(item.size)}</span>}
                  <span>{new Date(item.createdAt).toLocaleDateString()}</span>
                </div>
              </div>

              {/* Actions */}
              <div className="flex items-center gap-2">
                {(item.type === 'bgm' || item.type === 'sfx') && (
                  <button
                    onClick={() => togglePlay(item)}
                    className="w-10 h-10 rounded-full flex items-center justify-center transition-all hover:scale-110"
                    style={{ background: `${theme.primary}20`, color: theme.primaryLight }}
                  >
                    {playingId === item.id ? <Pause size={18} /> : <Play size={18} className="ml-0.5" />}
                  </button>
                )}
                <button
                  onClick={() => openEditModal(item)}
                  className="p-2 rounded-lg text-t-text3 hover:text-t-text1 hover:bg-t-card-hover transition-all"
                >
                  <Edit2 size={16} />
                </button>
                <button
                  onClick={() => handleDownload(item)}
                  className="p-2 rounded-lg text-t-text3 hover:text-t-text1 hover:bg-t-card-hover transition-all"
                >
                  <Download size={16} />
                </button>
                <button
                  onClick={() => handleDelete(item.id)}
                  className="p-2 rounded-lg text-t-text3 hover:text-red-400 hover:bg-red-500/10 transition-all"
                >
                  <Trash2 size={16} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Hidden audio element */}
      <audio ref={audioRef} className="hidden" />

      {/* Upload Modal */}
      {showUploadModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
          <div className="w-full max-w-lg rounded-2xl p-6 border border-t-border" style={{ background: 'var(--t-bg-base)' }}>
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-xl font-serif text-t-text1">
                {t.mediaLibrary?.uploadModal?.title || 'Upload Media'}
              </h2>
              <button onClick={closeUploadModal} className="p-2 rounded-lg text-t-text3 hover:text-t-text1 hover:bg-t-card-hover">
                <X size={20} />
              </button>
            </div>

            {/* Preview */}
            {uploadedFile && (
              <div className="mb-6 p-4 rounded-xl border border-t-border" style={{ background: `${theme.primary}10` }}>
                {uploadedFile.mimeType.startsWith('image/') ? (
                  <img src={uploadedFile.dataUrl} alt="Preview" className="w-full h-40 object-contain rounded-lg" />
                ) : (
                  <div className="flex items-center gap-4">
                    <div className="w-16 h-16 rounded-xl flex items-center justify-center" style={{ background: `${theme.primary}20` }}>
                      {uploadForm.type === 'bgm' ? <Music size={28} style={{ color: theme.primaryLight }} /> : <Sparkles size={28} style={{ color: theme.primaryLight }} />}
                    </div>
                    <div>
                      <p className="text-t-text1 font-medium">{uploadForm.name || 'Audio file'}</p>
                      <p className="text-t-text3 text-sm">
                        {uploadedFile.duration && formatDuration(uploadedFile.duration)} · {formatFileSize(uploadedFile.size)}
                      </p>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Form */}
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-t-text3 mb-2">{t.mediaLibrary?.form?.name || 'Name'}</label>
                <input
                  type="text"
                  value={uploadForm.name}
                  onChange={(e) => setUploadForm(prev => ({ ...prev, name: e.target.value }))}
                  className="w-full px-4 py-3 rounded-xl border border-t-border bg-t-card text-t-text1 focus:outline-none focus:border-t-border"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-t-text3 mb-2">{t.mediaLibrary?.form?.type || 'Type'}</label>
                <select
                  value={uploadForm.type}
                  onChange={(e) => setUploadForm(prev => ({ ...prev, type: e.target.value as MediaType }))}
                  className="w-full px-4 py-3 rounded-xl border border-t-border bg-t-card text-t-text1 focus:outline-none focus:border-t-border"
                >
                  <option value="image" className="bg-gray-900">Image</option>
                  <option value="bgm" className="bg-gray-900">Background Music</option>
                  <option value="sfx" className="bg-gray-900">Sound Effect</option>
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-t-text3 mb-2">{t.mediaLibrary?.form?.description || 'Description'}</label>
                <textarea
                  value={uploadForm.description}
                  onChange={(e) => setUploadForm(prev => ({ ...prev, description: e.target.value }))}
                  rows={2}
                  className="w-full px-4 py-3 rounded-xl border border-t-border bg-t-card text-t-text1 focus:outline-none focus:border-t-border resize-none"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-t-text3 mb-2">{t.mediaLibrary?.form?.tags || 'Tags'}</label>
                <input
                  type="text"
                  value={uploadForm.tags}
                  onChange={(e) => setUploadForm(prev => ({ ...prev, tags: e.target.value }))}
                  placeholder={t.mediaLibrary?.form?.tagsPlaceholder || 'Separate with commas'}
                  className="w-full px-4 py-3 rounded-xl border border-t-border bg-t-card text-t-text1 focus:outline-none focus:border-t-border"
                />
              </div>

              {/* Project Links */}
              <div>
                <label className="block text-sm font-medium text-t-text3 mb-2">
                  <Link2 size={14} className="inline mr-1" />
                  {t.mediaLibrary?.form?.linkedProjects || 'Linked Projects'}
                </label>
                <div className="flex flex-wrap gap-2">
                  {projects.map(p => {
                    const isLinked = uploadForm.projectIds.includes(p.id);
                    return (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => {
                          setUploadForm(prev => ({
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
                    <span className="text-t-text3 text-sm">{t.mediaLibrary?.noProjects || 'No projects'}</span>
                  )}
                </div>
              </div>
            </div>

            {/* Actions */}
            <div className="flex gap-3 mt-6">
              <button
                onClick={closeUploadModal}
                className="flex-1 px-4 py-3 rounded-xl border border-t-border text-t-text2 hover:text-t-text1 hover:border-t-border transition-all"
              >
                {t.common?.cancel || 'Cancel'}
              </button>
              <button
                onClick={saveUploadedMedia}
                disabled={!uploadForm.name.trim()}
                className="flex-1 px-4 py-3 rounded-xl text-t-text1 font-medium transition-all disabled:opacity-50"
                style={{ background: theme.primary }}
              >
                {t.common?.save || 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Generate Modal */}
      {showGenerateModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
          <div className="w-full max-w-lg rounded-2xl p-6 border border-t-border" style={{ background: 'var(--t-bg-base)' }}>
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-xl font-serif text-t-text1">
                {t.mediaLibrary?.generateModal?.title || 'Generate with AI'}
              </h2>
              <button onClick={closeGenerateModal} className="p-2 rounded-lg text-t-text3 hover:text-t-text1 hover:bg-t-card-hover">
                <X size={20} />
              </button>
            </div>

            <div className="space-y-4">
              {/* Type selector */}
              <div>
                <label className="block text-sm font-medium text-t-text3 mb-2">{t.mediaLibrary?.form?.type || 'Type'}</label>
                <div className="flex gap-2">
                  {[
                    { id: 'image' as MediaType, label: t.mediaLibrary?.tabs?.images || 'Image', icon: ImagePlus },
                    { id: 'bgm' as MediaType, label: t.mediaLibrary?.tabs?.bgm || 'BGM', icon: Music },
                    { id: 'sfx' as MediaType, label: t.mediaLibrary?.tabs?.sfx || 'SFX', icon: Volume2 },
                  ].map(opt => {
                    const Icon = opt.icon;
                    return (
                      <button
                        key={opt.id}
                        onClick={() => setGenerateType(opt.id)}
                        className={`flex-1 flex items-center justify-center gap-2 px-4 py-3 rounded-xl border transition-all ${
                          generateType === opt.id
                            ? 'border-t-border text-t-text1'
                            : 'border-t-border text-t-text3 hover:border-t-border'
                        }`}
                        style={generateType === opt.id ? { background: `${theme.primary}20` } : {}}
                      >
                        <Icon size={18} />
                        {opt.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Prompt */}
              <div>
                <label className="block text-sm font-medium text-t-text3 mb-2">
                  {t.mediaLibrary?.generateModal?.prompt || 'Describe what you want'}
                </label>
                <textarea
                  value={generatePrompt}
                  onChange={(e) => setGeneratePrompt(e.target.value)}
                  rows={3}
                  placeholder={
                    generateType === 'image' 
                      ? (t.mediaLibrary?.generateModal?.imagePlaceholder || 'A serene mountain landscape at sunset...')
                      : generateType === 'bgm'
                      ? (t.mediaLibrary?.generateModal?.bgmPlaceholder || 'Calm meditation music with soft piano...')
                      : (t.mediaLibrary?.generateModal?.sfxPlaceholder || 'Gentle bell chime sound...')
                  }
                  className="w-full px-4 py-3 rounded-xl border border-t-border bg-t-card text-t-text1 focus:outline-none focus:border-t-border resize-none"
                />
              </div>

              {/* Duration (for audio) */}
              {(generateType === 'bgm' || generateType === 'sfx') && (
                <div>
                  <label className="block text-sm font-medium text-t-text3 mb-2">
                    {t.mediaLibrary?.generateModal?.duration || 'Duration (seconds)'}
                  </label>
                  <div className="flex items-center gap-3">
                    <input
                      type="range"
                      value={generateDuration}
                      onChange={(e) => setGenerateDuration(parseInt(e.target.value))}
                      min={3}
                      max={30}
                      step={1}
                      className="flex-1 accent-current"
                      style={{ accentColor: theme.primary }}
                    />
                    <div className="flex items-center gap-1.5">
                      <input
                        type="number"
                        value={generateDuration}
                        onChange={(e) => {
                          const val = parseInt(e.target.value);
                          if (!isNaN(val)) setGenerateDuration(Math.max(3, Math.min(30, val)));
                        }}
                        min={3}
                        max={30}
                        className="w-16 px-2 py-2 rounded-lg border border-t-border bg-t-card text-t-text1 text-center text-sm focus:outline-none focus:border-t-border"
                      />
                      <span className="text-sm text-t-text3">s</span>
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Actions */}
            <div className="flex gap-3 mt-6">
              <button
                onClick={closeGenerateModal}
                className="flex-1 px-4 py-3 rounded-xl border border-t-border text-t-text2 hover:text-t-text1 hover:border-t-border transition-all"
              >
                {t.common?.cancel || 'Cancel'}
              </button>
              <button
                onClick={handleGenerate}
                disabled={isGenerating || !generatePrompt.trim()}
                className="flex-1 px-4 py-3 rounded-xl text-t-text1 font-medium transition-all disabled:opacity-50 flex items-center justify-center gap-2"
                style={{ background: theme.primary }}
              >
                {isGenerating ? (
                  <>
                    <Loader2 size={18} className="animate-spin" />
                    {t.mediaLibrary?.generating || 'Generating...'}
                  </>
                ) : (
                  <>
                    <Wand2 size={18} />
                    {t.mediaLibrary?.generate || 'Generate'}
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Edit Modal */}
      {showEditModal && editingItem && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
          <div className="w-full max-w-lg rounded-2xl p-6 border border-t-border" style={{ background: 'var(--t-bg-base)' }}>
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-xl font-serif text-t-text1">
                {t.mediaLibrary?.editModal?.title || 'Edit Media'}
              </h2>
              <button onClick={() => { setShowEditModal(false); setEditingItem(null); }} className="p-2 rounded-lg text-t-text3 hover:text-t-text1 hover:bg-t-card-hover">
                <X size={20} />
              </button>
            </div>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-t-text3 mb-2">{t.mediaLibrary?.form?.name || 'Name'}</label>
                <input
                  type="text"
                  value={editingItem.name}
                  onChange={(e) => setEditingItem({ ...editingItem, name: e.target.value })}
                  className="w-full px-4 py-3 rounded-xl border border-t-border bg-t-card text-t-text1 focus:outline-none focus:border-t-border"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-t-text3 mb-2">{t.mediaLibrary?.form?.description || 'Description'}</label>
                <textarea
                  value={editingItem.description}
                  onChange={(e) => setEditingItem({ ...editingItem, description: e.target.value })}
                  rows={3}
                  className="w-full px-4 py-3 rounded-xl border border-t-border bg-t-card text-t-text1 focus:outline-none focus:border-t-border resize-none"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-t-text3 mb-2">{t.mediaLibrary?.form?.tags || 'Tags'}</label>
                <input
                  type="text"
                  value={editingItem.tags.join(', ')}
                  onChange={(e) => setEditingItem({ ...editingItem, tags: e.target.value.split(',').map(t => t.trim()).filter(Boolean) })}
                  className="w-full px-4 py-3 rounded-xl border border-t-border bg-t-card text-t-text1 focus:outline-none focus:border-t-border"
                />
              </div>

              {/* Project Links */}
              <div>
                <label className="block text-sm font-medium text-t-text3 mb-2">
                  <Link2 size={14} className="inline mr-1" />
                  {t.mediaLibrary?.form?.linkedProjects || 'Linked Projects'}
                </label>
                <div className="flex flex-wrap gap-2">
                  {projects.map(p => {
                    const isLinked = editingItem.projectIds?.includes(p.id) || false;
                    return (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => {
                          const currentIds = editingItem.projectIds || [];
                          setEditingItem({
                            ...editingItem,
                            projectIds: isLinked 
                              ? currentIds.filter(id => id !== p.id)
                              : [...currentIds, p.id]
                          });
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
                    <span className="text-t-text3 text-sm">{t.mediaLibrary?.noProjects || 'No projects'}</span>
                  )}
                </div>
              </div>
            </div>

            <div className="flex gap-3 mt-6">
              <button
                onClick={() => { setShowEditModal(false); setEditingItem(null); }}
                className="flex-1 px-4 py-3 rounded-xl border border-t-border text-t-text2 hover:text-t-text1 hover:border-t-border transition-all"
              >
                {t.common?.cancel || 'Cancel'}
              </button>
              <button
                onClick={saveEditedMedia}
                className="flex-1 px-4 py-3 rounded-xl text-t-text1 font-medium transition-all"
                style={{ background: theme.primary }}
              >
                {t.common?.save || 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
