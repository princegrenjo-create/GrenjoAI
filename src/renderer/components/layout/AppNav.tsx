import type { ReactElement } from 'react';
import {
  AgentsIcon,
  ChatIcon,
  ModelsIcon,
  SettingsIcon,
  SparkIcon,
  SyncIcon,
} from '../icons';
import { Tooltip } from '../ui';
import { ROUTE_META, ROUTE_ORDER, routeToHash, type Route, type RouteName } from '@renderer/lib/router';

const NAV_ICONS: Record<RouteName, ReactElement> = {
  chat: <ChatIcon />,
  agents: <AgentsIcon />,
  models: <ModelsIcon />,
  settings: <SettingsIcon />,
  sync: <SyncIcon />,
};

export interface AppNavProps {
  route: Route;
  onNavigate(name: RouteName): void;
}

/**
 * Primary navigation. It is a list of links (so it can be opened, focused and
 * announced like navigation) but the click is handled in-app: the packaged app
 * loads from `file://`, where a real navigation would reload the window.
 */
export function AppNav({ route, onNavigate }: AppNavProps): ReactElement {
  return (
    <nav className="pds-rail" aria-label="Main">
      <div className="pds-rail__brand">
        <span className="pds-rail__mark" aria-hidden="true">
          <SparkIcon />
        </span>
        <span className="pds-rail__name">Personal AI Desk</span>
      </div>

      <ul className="pds-nav">
        {ROUTE_ORDER.map((name) => (
          <li key={name} className="pds-nav__item">
            <Tooltip label={ROUTE_META[name].label} placement="right">
              <a
                href={routeToHash({ name, conversationId: null })}
                className="pds-nav__link"
                aria-label={ROUTE_META[name].label}
                aria-current={route.name === name ? 'page' : undefined}
                onClick={(event) => {
                  event.preventDefault();
                  onNavigate(name);
                }}
              >
                <span className="pds-nav__icon" aria-hidden="true">
                  {NAV_ICONS[name]}
                </span>
                <span className="pds-nav__label">{ROUTE_META[name].label}</span>
              </a>
            </Tooltip>
          </li>
        ))}
      </ul>

      <p className="pds-rail__note">
        Keys stay in the Windows credential store. Nothing is sent anywhere except to the provider
        you configured.
      </p>
    </nav>
  );
}
