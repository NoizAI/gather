import { useState, useEffect } from 'react';
import { ThemeProvider } from './contexts/ThemeContext';
import { ProjectProvider, useProjects } from './contexts/ProjectContext';
import './i18n'; // Initialize i18next
import { LanguageProvider } from './i18n/LanguageContext';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { Project, Episode } from './types';
import { Layout } from './components/Layout';
import { Landing, LandingData } from './components/Landing';
import { Dashboard } from './components/Dashboard';
import { ProjectList } from './components/ProjectList';
import { ProjectCreator } from './components/ProjectCreator';
import { ProjectDetail } from './components/ProjectDetail';
import { EpisodeCreator } from './components/EpisodeCreator';
import { EpisodeEditor } from './components/EpisodeEditor';
import { VoiceStudio } from './components/VoiceStudio';
import { MediaLibrary } from './components/MediaLibrary';
import { Settings } from './components/Settings';
import { FeedbackPanel } from './components/FeedbackPanel';
import { AdminFeedback } from './components/AdminFeedback';
import { AuthPage } from './components/AuthPage';
import { CreativeMode } from './components/CreativeMode';
import { ModeSelector, hasChosenMode, getSavedMode, saveChosenMode } from './components/ModeSelector';
import { Loader2 } from 'lucide-react';

type AppMode = 'workspace' | 'creative';
type Page = 'dashboard' | 'projects' | 'voice' | 'media' | 'feedback' | 'admin-feedback' | 'settings' | 'project-detail';

interface AppContentProps {
  initialLandingData: LandingData | null;
  onClearLandingData: () => void;
}

function AppContent({ initialLandingData, onClearLandingData, initialMode }: AppContentProps & { initialMode: AppMode }) {
  const { projects, currentProject, setCurrentProject, addEpisode, updateEpisode } = useProjects();
  
  const [appMode, setAppMode] = useState<AppMode>(initialMode);
  const [currentPage, setCurrentPage] = useState<Page>('dashboard');
  const [showProjectCreator, setShowProjectCreator] = useState(!!initialLandingData);
  const [showEpisodeCreator, setShowEpisodeCreator] = useState(false);
  const [editingEpisode, setEditingEpisode] = useState<Episode | null>(null);
  const [showEpisodeEditor, setShowEpisodeEditor] = useState(false);
  const [pendingProjectId, setPendingProjectId] = useState<string | null>(null);
  const [creativeContext, setCreativeContext] = useState<string | null>(null);

  // Navigate to project detail once the projects state has the newly created project
  useEffect(() => {
    if (!pendingProjectId) return;
    const project = projects.find(p => p.id === pendingProjectId);
    if (project) {
      setCurrentProject(project);
      setCurrentPage('project-detail');
      setPendingProjectId(null);
    }
  }, [pendingProjectId, projects, setCurrentProject]);

  const handleNavigate = (page: string) => {
    setCurrentPage(page as Page);
    setCurrentProject(null);
  };

  const handleViewProject = (project: Project) => {
    setCurrentProject(project);
    setCurrentPage('project-detail');
  };

  const handleEditProject = (project: Project) => {
    setCurrentProject(project);
    setCurrentPage('project-detail');
  };

  const handleCreateEpisode = () => {
    // Use EpisodeCreator for new episodes (with script generation)
    setShowEpisodeCreator(true);
  };

  const handleEditEpisode = (episode: Episode) => {
    setEditingEpisode(episode);
    setShowEpisodeEditor(true);
  };

  const handleSaveEpisode = (episodeData: Omit<Episode, 'id' | 'createdAt' | 'updatedAt'>) => {
    if (!currentProject) return;

    if (editingEpisode) {
      updateEpisode(currentProject.id, {
        ...editingEpisode,
        ...episodeData,
        updatedAt: new Date().toISOString(),
      });
    } else {
      addEpisode(currentProject.id, episodeData);
    }

    setShowEpisodeEditor(false);
    setEditingEpisode(null);
  };

  const handleSwitchToCreative = () => {
    setAppMode('creative');
    saveChosenMode('creative');
  };

  const handleSwitchToWorkspace = () => {
    setAppMode('workspace');
    saveChosenMode('workspace');
  };

  const handleStartProductionFromCreative = (conversationContext: string) => {
    setCreativeContext(conversationContext);
    setAppMode('workspace');
    setShowProjectCreator(true);
  };

  const renderContent = () => {
    if (currentPage === 'project-detail' && currentProject) {
      return (
        <ProjectDetail
          project={currentProject}
          onBack={() => { setCurrentProject(null); setCurrentPage('projects'); }}
          onEditEpisode={handleEditEpisode}
          onCreateEpisode={handleCreateEpisode}
        />
      );
    }

    switch (currentPage) {
      case 'dashboard':
        return <Dashboard onCreateProject={() => setShowProjectCreator(true)} onViewProjects={() => setCurrentPage('projects')} onViewProject={handleViewProject} />;
      case 'projects':
        return <ProjectList onCreateProject={() => setShowProjectCreator(true)} onViewProject={handleViewProject} onEditProject={handleEditProject} />;
      case 'voice':
        return <VoiceStudio />;
      case 'media':
        return <MediaLibrary />;
      case 'feedback':
        return <FeedbackPanel />;
      case 'admin-feedback':
        return <AdminFeedback />;
      case 'settings':
        return <Settings />;
      default:
        return <Dashboard onCreateProject={() => setShowProjectCreator(true)} onViewProjects={() => setCurrentPage('projects')} onViewProject={handleViewProject} />;
    }
  };

  if (appMode === 'creative') {
    return (
      <CreativeMode
        onSwitchToWorkspace={handleSwitchToWorkspace}
        onStartProduction={handleStartProductionFromCreative}
      />
    );
  }

  return (
    <>
      <Layout onNavigate={handleNavigate} currentPage={currentPage} onSwitchToCreative={handleSwitchToCreative}>
        {renderContent()}
      </Layout>

      {showProjectCreator && (
        <ProjectCreator
          onClose={() => { setShowProjectCreator(false); onClearLandingData(); setCreativeContext(null); }}
          onSuccess={(projectId?: string) => { 
            setShowProjectCreator(false); 
            onClearLandingData(); 
            setCreativeContext(null);
            if (projectId) {
              setPendingProjectId(projectId);
            }
            setCurrentPage('projects'); 
          }}
          initialData={initialLandingData || undefined}
          creativeContext={creativeContext || undefined}
        />
      )}

      {showEpisodeCreator && currentProject && (
        <EpisodeCreator
          project={currentProject}
          onClose={() => setShowEpisodeCreator(false)}
          onSuccess={() => { 
            setShowEpisodeCreator(false);
          }}
        />
      )}

      {showEpisodeEditor && currentProject && (
        <EpisodeEditor
          episode={editingEpisode || undefined}
          project={currentProject}
          onSave={handleSaveEpisode}
          onClose={() => { setShowEpisodeEditor(false); setEditingEpisode(null); }}
        />
      )}
    </>
  );
}

// Loading screen component
function LoadingScreen() {
  return (
    <div className="min-h-screen flex items-center justify-center" style={{ background: 'var(--t-bg)' }}>
      <div className="flex flex-col items-center gap-4">
        <Loader2 size={40} className="animate-spin text-t-primary" />
        <p className="text-t-text3 text-sm">加载中...</p>
      </div>
    </div>
  );
}

// Authenticated app content wrapper
function AuthenticatedApp() {
  const { isAuthenticated, isLoading } = useAuth();
  const [showLanding, setShowLanding] = useState(false);
  const [landingData, setLandingData] = useState<LandingData | null>(null);
  const [showModeSelector, setShowModeSelector] = useState(() => !hasChosenMode());
  const [initialMode, setInitialMode] = useState<AppMode>(() => getSavedMode() || 'workspace');

  const handleEnterWorkspace = (data?: LandingData) => {
    if (data) {
      setLandingData(data);
    }
    setShowLanding(false);
  };

  const handleModeSelected = (mode: AppMode) => {
    setInitialMode(mode);
    setShowModeSelector(false);
  };

  // Show loading screen while checking auth
  if (isLoading) {
    return <LoadingScreen />;
  }

  // Show auth page if not authenticated
  if (!isAuthenticated) {
    return <AuthPage />;
  }

  // Show mode selector for first-time users
  if (showModeSelector) {
    return <ModeSelector onSelect={handleModeSelected} />;
  }

  // Show main app content
  return (
    <>
      {showLanding ? (
        <Landing onEnterWorkspace={handleEnterWorkspace} />
      ) : (
        <ProjectProvider>
          <AppContent initialLandingData={landingData} onClearLandingData={() => setLandingData(null)} initialMode={initialMode} />
        </ProjectProvider>
      )}
    </>
  );
}

function App() {
  return (
    <LanguageProvider>
      <ThemeProvider>
        <AuthProvider>
          <AuthenticatedApp />
        </AuthProvider>
      </ThemeProvider>
    </LanguageProvider>
  );
}

export default App;
