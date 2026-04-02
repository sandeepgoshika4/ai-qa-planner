export interface PageElement {
  elementId: string;
  tag: string;
  text: string;
  name?: string | null;
  idAttr?: string | null;
  placeholder?: string | null;
  ariaLabel?: string | null;
  role?: string | null;
  href?: string | null;
  selector: string;
  visible: boolean;
  enabled: boolean;
}

export interface PageContext {
  url: string;
  title: string;
  dom: string;
  elements: PageElement[];
}
