import { useTheme } from '../contexts/ThemeContext';
import { useProjects } from '../contexts/ProjectContext';
import { useLanguage } from '../i18n/LanguageContext';
import { useAuth } from '../contexts/AuthContext';
import { Mic2, TrendingUp, ArrowRight, FileText, Plus } from 'lucide-react';
import { RoleBadge } from './RoleBadge';
import type { Project } from '../types';

interface DashboardProps {
  onCreateProject: () => void;
  onViewProjects: () => void;
  onViewProject: (project: Project) => void;
}

export function Dashboard({ onCreateProject, onViewProjects, onViewProject }: DashboardProps) {
  const { theme, religion } = useTheme();
  const { getProjectsByReligion } = useProjects();
  const { t } = useLanguage();
  const { user } = useAuth();

  const myProjects = getProjectsByReligion(religion);
  const totalEpisodes = myProjects.reduce((acc, p) => acc + p.episodes.length, 0);

  const recentProjects = [...myProjects]
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .slice(0, 3);

  const religionT = t.religions[religion];

  return (
    <div className="space-y-6 md:space-y-8 animate-fade-in">
      {/* Welcome Header */}
      <div>
        <div className="flex items-center gap-3 flex-wrap">
          <h1 className="text-xl sm:text-2xl md:text-3xl font-serif font-light text-t-text1 tracking-wide">
            {t.dashboard.welcome}
          </h1>
          {user && <RoleBadge role={user.role} size="sm" />}
        </div>
        <p className="text-t-text3 mt-1 text-sm md:text-base">
          {religionT.description}
        </p>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-2 gap-3 md:gap-6">
        {[
          { label: t.dashboard.podcastProjects, value: myProjects.length, icon: Mic2, onClick: onViewProjects },
          { label: t.dashboard.totalEpisodes, value: totalEpisodes, icon: TrendingUp, onClick: onViewProjects },
        ].map((stat, index) => {
          const Icon = stat.icon;
          return (
            <div 
              key={index}
              onClick={stat.onClick}
              className="rounded-xl md:rounded-2xl p-3 sm:p-4 md:p-6 border border-t-border backdrop-blur-sm transition-all duration-300 hover:border-t-border cursor-pointer"
              style={{ background: 'var(--t-bg-card)' }}
            >
              <div className="flex flex-col md:flex-row md:items-center gap-2 md:gap-4">
                <div 
                  className="w-10 h-10 md:w-12 md:h-12 rounded-lg md:rounded-xl flex items-center justify-center flex-shrink-0"
                  style={{ background: `${theme.primary}20` }}
                >
                  <Icon size={18} className="md:hidden" color={theme.primaryLight} />
                  <Icon size={22} className="hidden md:block" color={theme.primaryLight} />
                </div>
                <div>
                  <p className="text-t-text3 text-[10px] sm:text-xs md:text-sm line-clamp-1">{stat.label}</p>
                  <p 
                    className="text-xl sm:text-2xl md:text-3xl font-light tracking-wide text-t-text1"
                  >
                    {stat.value}
                  </p>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Quick Action */}
      <button
        onClick={onCreateProject}
        className="w-full flex items-center justify-center gap-3 px-5 py-4 md:py-5 rounded-xl md:rounded-2xl font-medium transition-all duration-300 hover:scale-[1.02] border border-t-border"
        style={{ 
          background: 'var(--t-bg-card)',
        }}
      >
        <div 
          className="w-10 h-10 rounded-lg flex items-center justify-center"
          style={{ background: `${theme.primary}20` }}
        >
          <Plus size={20} color={theme.primaryLight} />
        </div>
        <span className="text-t-text1 text-sm md:text-base">{t.dashboard.newProduction}</span>
      </button>

      {/* Recent Projects */}
      <div 
        className="rounded-xl md:rounded-2xl p-4 sm:p-6 lg:p-8 border border-t-border"
        style={{ background: 'var(--t-bg-card)' }}
      >
        <div className="flex items-center justify-between mb-4 md:mb-6">
          <h2 className="text-lg md:text-xl font-serif text-t-text1 tracking-wide">
            {t.dashboard.recentProjects}
          </h2>
          <button
            onClick={onViewProjects}
            className="flex items-center gap-1.5 text-xs md:text-sm text-t-text2 hover:text-t-text1 transition-colors"
          >
            {t.dashboard.viewAll}
            <ArrowRight size={14} />
          </button>
        </div>
        {recentProjects.length > 0 ? (
          <div className="space-y-2 md:space-y-3">
            {recentProjects.map((project) => (
              <div
                key={project.id}
                className="flex items-center justify-between p-3 md:p-4 rounded-lg md:rounded-xl border border-t-border-lt hover:border-t-border transition-all duration-300 cursor-pointer group gap-3"
                style={{ background: `${theme.primary}05` }}
                onClick={() => onViewProject(project)}
              >
                <div className="flex items-center gap-3 md:gap-4 min-w-0 flex-1">
                  <div 
                    className="w-1.5 md:w-2 h-8 md:h-10 rounded-full flex-shrink-0"
                    style={{ background: theme.primary }}
                  />
                  <div className="min-w-0 flex-1">
                    <h3 className="font-medium text-t-text1 group-hover:text-t-text1 transition-colors text-sm md:text-base truncate">
                      {project.title}
                    </h3>
                    <p className="text-xs md:text-sm text-t-text3 truncate">
                      {project.episodes.length} {t.dashboard.episodes} · {new Date(project.updatedAt).toLocaleDateString()}
                    </p>
                  </div>
                </div>
                <div 
                  className="flex items-center gap-1.5 px-2 md:px-3 py-1 md:py-1.5 rounded-md md:rounded-lg text-[10px] md:text-sm flex-shrink-0"
                  style={{ 
                    background: `${theme.primary}20`,
                    color: theme.primaryLight,
                  }}
                >
                  <FileText size={12} className="md:hidden" color={theme.primaryLight} />
                  <FileText size={14} className="hidden md:block" color={theme.primaryLight} />
                  <span>{project.episodes.length}</span>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="text-center py-10 md:py-16">
            <div 
              className="w-12 h-12 md:w-16 md:h-16 rounded-xl md:rounded-2xl flex items-center justify-center mx-auto mb-3 md:mb-4"
              style={{ background: `${theme.primary}20` }}
            >
              <Mic2 size={24} className="md:hidden" color={theme.primaryLight} style={{ opacity: 0.5 }} />
              <Mic2 size={28} className="hidden md:block" color={theme.primaryLight} style={{ opacity: 0.5 }} />
            </div>
            <p className="text-t-text3 text-sm md:text-base">{t.dashboard.noProjects}</p>
          </div>
        )}
      </div>
    </div>
  );
}
