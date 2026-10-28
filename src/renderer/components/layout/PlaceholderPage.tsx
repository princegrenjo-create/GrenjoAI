import type { ReactElement } from 'react';
import { CheckIcon } from '../icons';
import { ROUTE_META, type RouteName } from '@renderer/lib/router';
import { Badge, Card, CardBody, CardHeader, List, ListItem } from '../ui';
import { Page } from './Page';

export interface PlaceholderPageProps {
  routeName: RouteName;
  /** Capabilities the owning screen will provide once it is built. */
  planned: string[];
}

/**
 * Deliberate placeholder for a screen owned by another part of the build. The
 * route, the navigation entry and the page frame are real; the body is not, and
 * says so instead of pretending with fake content.
 */
export function PlaceholderPage({ routeName, planned }: PlaceholderPageProps): ReactElement {
  const meta = ROUTE_META[routeName];

  return (
    <Page
      title={meta.title}
      description={meta.description}
      actions={
        <Badge tone="warning" dot>
          Not built yet
        </Badge>
      }
    >
      <Card>
        <CardHeader
          title="This screen is a placeholder"
          description="The navigation entry and route are wired. The page body is built separately and will replace this component."
        />
        <CardBody>
          <List label={`Planned for ${meta.label}`}>
            {planned.map((item) => (
              <ListItem key={item} icon={<CheckIcon />}>
                {item}
              </ListItem>
            ))}
          </List>
        </CardBody>
      </Card>
    </Page>
  );
}
